'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { probeMedia } = require('./probe');
const { extractSignatures } = require('./signature');
const { buildAnchors, runLocators } = require('./anchors');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDirs() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function loadDb() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    return {
      media: {},      // contentId -> media record
      names: {},      // filename -> { contentIds: [] }
      annotations: {} // contentId -> [annotation]
    };
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

let db = null;
function dbGet() {
  if (!db) db = loadDb();
  return db;
}
function dbSave() {
  ensureDirs();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dbGet(), null, 1));
  fs.renameSync(tmp, DB_FILE);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/*
 * Ingest an uploaded file.
 * Identity is the SHA-256 of the bytes, never the filename: two different
 * clips uploaded under the same name never merge; identical bytes uploaded
 * again attach a new version label to the existing content identity.
 */
function ingestMedia(originalName, tempPath) {
  const database = dbGet();
  const contentId = sha256File(tempPath);

  let media = database.media[contentId];
  let reUpload = false;

  if (media) {
    // Identical bytes uploaded again: record a new version event only.
    // A legacy record may still lack signatures; re-upload is a good moment
    // to rebuild them from the stored bytes.
    ensureSignatureTable(media);
    reUpload = true;
    const versionSeq = media.versions.length + 1;
    media.versions.push({
      versionId: `${contentId.slice(0, 12)}-v${versionSeq}`,
      fileName: originalName,
      uploadedAt: new Date().toISOString()
    });
  } else {
    const frameTable = probeMedia(tempPath);
    const signatureTable = extractSignatures(tempPath);
    // A signature table shorter than the frame table would silently shift
    // every later content match, so refuse instead of padding or truncating.
    if (signatureTable.frames.length !== frameTable.frames.length) {
      throw new Error(
        `signature/frame count mismatch: ${signatureTable.frames.length} vs ${frameTable.frames.length}`
      );
    }
    const storedName = `${contentId}${path.extname(originalName) || '.bin'}`;
    const dest = path.join(MEDIA_DIR, storedName);
    try {
      fs.renameSync(tempPath, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(tempPath, dest);
      fs.unlinkSync(tempPath);
    }

    media = {
      contentId,
      storageFile: storedName,
      frameTable,
      signatureTable,
      createdAt: new Date().toISOString(),
      versions: [
        {
          versionId: `${contentId.slice(0, 12)}-v1`,
          fileName: originalName,
          uploadedAt: new Date().toISOString()
        }
      ]
    };
    database.media[contentId] = media;
    database.annotations[contentId] = [];
  }

  if (!database.names[originalName]) database.names[originalName] = { contentIds: [] };
  const entry = database.names[originalName];
  if (!entry.contentIds.includes(contentId)) entry.contentIds.push(contentId);

  dbSave();
  return { media, reUpload };
}

function getMedia(contentId) {
  const media = dbGet().media[contentId];
  if (media) ensureSignatureTable(media);
  return media || null;
}

/*
 * Media ingested before signatures existed has no signatureTable. Rebuild it
 * from the stored bytes on first access and persist, so a legacy record either
 * gains a real table or fails loudly; it never falls back to a default.
 */
function ensureSignatureTable(media) {
  if (media.signatureTable) return media.signatureTable;
  const filePath = mediaFilePath(media);
  if (!fs.existsSync(filePath)) {
    throw new Error(`media ${media.contentId.slice(0, 12)} has no stored file; cannot rebuild signatures`);
  }
  const table = extractSignatures(filePath);
  if (table.frames.length !== media.frameTable.frames.length) {
    throw new Error(
      `legacy signature rebuild mismatch: ${table.frames.length} vs ${media.frameTable.frames.length}`
    );
  }
  media.signatureTable = table;
  dbSave();
  return table;
}

function listMedia() {
  const database = dbGet();
  const out = [];
  for (const m of Object.values(database.media)) {
    ensureSignatureTable(m);
    out.push(publicMedia(m));
  }
  return out;
}

function publicMedia(media) {
  return {
    contentId: media.contentId,
    versions: media.versions,
    signature: {
      kind: media.signatureTable.kind,
      grid: media.signatureTable.grid,
      frameCount: media.signatureTable.frames.length
    },
    frameTable: {
      codec: media.frameTable.codec,
      codedWidth: media.frameTable.codedWidth,
      codedHeight: media.frameTable.codedHeight,
      rotation: media.frameTable.rotation,
      frameCount: media.frameTable.frameCount,
      durationSec: media.frameTable.durationSec,
      isCfr: media.frameTable.isCfr,
      frameRate: media.frameTable.frameRate,
      timeBase: media.frameTable.timeBase,
      step: media.frameTable.step,
      firstPtsTime: media.frameTable.firstPtsTime,
      frames: media.frameTable.frames
    }
  };
}

function mediaFilePath(media) {
  return path.join(MEDIA_DIR, media.storageFile);
}

/*
 * Annotation binding (the core contract):
 *   contentId : content identity (hash), not player progress
 *   track     : named track inside the clip
 *   frameIndex + ptsTime + timeBase : exact frame/time identity; decimal
 *                                     seconds alone are never trusted
 *   region    : normalized material-axis coordinates (pre-rotation)
 *   sourceVersionId + sourceFileName : which uploaded version created it
 *   anchors   : both locators' data (media-time-interval + content-signature)
 *   anchorCheck : locator results against the source itself at write time,
 *                 so a stored anchor can never look valid by default.
 */
function addAnnotation(contentId, input) {
  const database = dbGet();
  const media = database.media[contentId];
  if (!media) throw new Error('unknown contentId');
  ensureSignatureTable(media);
  const ft = media.frameTable;
  const frame = ft.frames[input.frameIndex];
  if (!frame) throw new Error('frameIndex out of range');
  if (typeof frame.ptsTime !== 'number') throw new Error('frame has no pts');

  const sourceVersion = media.versions.find(
    (v) => v.versionId === input.sourceVersionId
  ) || media.versions[media.versions.length - 1];

  const anchors = buildAnchors(media, input.frameIndex);
  const shownFrame = input.verifiedFrameIndex === undefined
    ? input.frameIndex
    : input.verifiedFrameIndex;
  if (shownFrame !== input.frameIndex) {
    throw new Error(`write frame ${input.frameIndex} does not match verified displayed frame ${shownFrame}`);
  }

  const annotation = {
    annotationId: crypto.randomUUID(),
    contentId,
    track: String(input.track || 'main'),
    frameIndex: input.frameIndex,
    ptsTime: frame.ptsTime,
    frameTime: frame.time,
    timeBase: ft.timeBase,
    isCfr: ft.isCfr,
    frameRate: ft.frameRate,
    frameCount: ft.frameCount,
    codedWidth: ft.codedWidth,
    codedHeight: ft.codedHeight,
    rotation: ft.rotation,
    region: {
      xn: Number(input.region.xn),
      yn: Number(input.region.yn),
      wn: Number(input.region.wn),
      hn: Number(input.region.hn)
    },
    text: String(input.text || '').slice(0, 4000),
    author: String(input.author || 'reviewer').slice(0, 80),
    sourceVersionId: sourceVersion.versionId,
    sourceFileName: sourceVersion.fileName,
    anchors,
    anchorCheck: runLocators(anchors, media),
    createdAt: new Date().toISOString()
  };

  database.annotations[contentId].push(annotation);
  dbSave();
  return annotation;
}

function listAnnotations(contentId) {
  const database = dbGet();
  return (database.annotations[contentId] || []).slice();
}

/*
 * Edit annotation text/track only. Anchors stay bound to the frame they were
 * written on: silently re-anchoring an edited note to another frame would
 * make "where was this said" depend on who edited last.
 */
function updateAnnotation(contentId, annotationId, input) {
  const database = dbGet();
  const annotation = (database.annotations[contentId] || []).find(
    (a) => a.annotationId === annotationId
  );
  if (!annotation) throw new Error('unknown annotation');
  if (input.frameIndex !== undefined && input.frameIndex !== annotation.frameIndex) {
    throw new Error('annotation frame is immutable; create a new annotation instead');
  }
  if (input.text !== undefined) annotation.text = String(input.text).slice(0, 4000);
  if (input.track !== undefined) annotation.track = String(input.track).slice(0, 80);
  annotation.editedAt = new Date().toISOString();
  annotation.editedBy = String(input.author || annotation.author).slice(0, 80);
  dbSave();
  return annotation;
}

/*
 * Re-resolve one annotation's anchors against a target media (defaults to the
 * annotation's own content). Legacy annotations without anchors return an
 * explicit null result instead of a fabricated match.
 */
function locateAnnotation(contentId, annotationId, targetContentId) {
  const database = dbGet();
  const annotation = (database.annotations[contentId] || []).find(
    (a) => a.annotationId === annotationId
  );
  if (!annotation) throw new Error('unknown annotation');
  const target = database.media[targetContentId || contentId];
  if (!target) throw new Error('unknown target contentId');
  ensureSignatureTable(target);
  if (!annotation.anchors) {
    return { annotationId, targetContentId: target.contentId, anchors: null, result: null, error: 'legacy annotation has no anchors' };
  }
  return {
    annotationId,
    targetContentId: target.contentId,
    anchors: annotation.anchors,
    result: runLocators(annotation.anchors, target)
  };
}

function listAllAnnotations() {
  const database = dbGet();
  const out = [];
  for (const id of Object.keys(database.annotations)) {
    out.push(...database.annotations[id]);
  }
  return out;
}

function resetForTests() {
  db = null;
  dbGet();
  dbSave();
}

module.exports = {
  ingestMedia,
  listMedia,
  getMedia,
  publicMedia,
  mediaFilePath,
  addAnnotation,
  updateAnnotation,
  listAnnotations,
  listAllAnnotations,
  locateAnnotation,
  resetForTests,
  DATA_DIR
};
