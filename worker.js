import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const pexec = promisify(execFile);
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PROJECTS_BUCKET = 'projects';   // adjust if your bucket is named differently

// very small loop: claim -> compile -> upload
async function main() {
  console.log('Worker started');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await claimJob();
    if (!job) { await sleep(2000); continue; }
    try {
      console.log('Running job', job.id);
      await runJob(job);
      await updateJob(job.id, { status: 'succeeded' });
    } catch (e) {
      console.error('Job failed', job.id, e);
      await updateJob(job.id, { status: 'failed', error_code: 'COMPILE_FAILED', error_detail: String(e).slice(0,4000) });
    }
  }
}

async function claimJob() {
  const { data, error } = await supa.rpc('claim_render_job');
  if (error) { console.error('claim error', error.message); return null; }
  return data;
}

async function runJob(job) {
  // 1) Load inputs from Storage/DB
  const ai = await readJSON(`projects/${job.project_id}/ai_summary.json`);
  const { data: tmplRow } = await supa.from('templates').select('*').eq('id', job.template_id).single();
  if (!tmplRow) throw new Error('TEMPLATE_NOT_FOUND');

  // 2) Build main.tex (minimal: replace placeholders)
  let tex = tmplRow.beamer_tex_template;
  tex = ensureGraphicx(tex);
  tex = replaceAll(tex, '{{TITLE}}', latex(ai.title||''));
  tex = replaceAll(tex, '{{AUTHORS}}', latex(ai.authors||''));
  tex = replaceAll(tex, '{{AFFILIATIONS}}', latex(ai.affiliations||''));
  tex = replaceAll(tex, '{{INTRO}}', latex(ai.intro||''));
  tex = replaceAll(tex, '{{METHODS}}', latex(ai.methods||''));
  tex = replaceAll(tex, '{{RESULTS}}', latex(ai.results||''));
  tex = replaceAll(tex, '{{DISCUSSION}}', latex(ai.discussion||''));
  tex = replaceAll(tex, '{{CONCLUSION}}', latex(ai.conclusion||''));
  const figs = (ai.figures||[]).slice(0,2);
  tex = replaceAll(tex, '{{FIGURE_1}}', figs[0]?.filePath ? `assets/${path.basename(figs[0].filePath)}` : '');
  tex = replaceAll(tex, '{{CAPTION_1}}', latex(figs[0]?.caption||''));
  tex = replaceAll(tex, '{{FIGURE_2}}', figs[1]?.filePath ? `assets/${path.basename(figs[1].filePath)}` : '');
  tex = replaceAll(tex, '{{CAPTION_2}}', latex(figs[1]?.caption||''));

  // Inject a simple watermark for preview
  if (job.mode === 'preview') tex = addWatermark(tex);

  // 3) Prepare working dir
  const work = await fs.mkdtemp('/tmp/poster-');
  const posterDir = path.join(work, 'poster'); await fs.mkdir(posterDir);
  const assetsDir = path.join(posterDir, 'assets'); await fs.mkdir(assetsDir);
  await fs.writeFile(path.join(posterDir, 'main.tex'), tex, 'utf8');

  // download figure files if any
  for (const f of figs) {
    if (!f?.filePath) continue;
    await downloadTo(path.join(assetsDir, path.basename(f.filePath)), `${PROJECTS_BUCKET}/${job.project_id}/poster/assets/${path.basename(f.filePath)}`);
  }

  // 4) Compile with tectonic
  const outDir = path.join(work, 'out'); await fs.mkdir(outDir);
  await runTectonic(path.join(posterDir, 'main.tex'), outDir);

  const pdfOut = path.join(outDir, 'main.pdf');
  const pdfKey = `projects/${job.project_id}/poster/${job.mode==='preview'?'preview':'final'}.pdf`;
  await uploadFrom(pdfKey, pdfOut, 'application/pdf');

  // 5) For paid, zip sources
  if (job.mode === 'paid') {
    const zip = new AdmZip();
    zip.addLocalFile(path.join(posterDir, 'main.tex'));
    zip.addLocalFolder(assetsDir, 'assets');
    const zipPath = path.join(work, 'poster_source.zip');
    zip.writeZip(zipPath);
    const zipKey = `projects/${job.project_id}/poster/poster_source.zip`;
    await uploadFrom(zipKey, zipPath, 'application/zip');
    await updateJob(job.id, { pdf_path: pdfKey, zip_path: zipKey });
  } else {
    await updateJob(job.id, { pdf_path: pdfKey });
  }
}

function ensureGraphicx(tex) {
  if (!tex.includes('\\usepackage{graphicx}')) {
    tex = tex.replace('\\usepackage{lmodern}', '\\usepackage{lmodern}\n\\usepackage{graphicx}\n\\graphicspath{{./assets/}}');
  }
  if (!tex.includes('\\graphicspath')) {
    tex = tex.replace('\\usepackage{graphicx}', '\\usepackage{graphicx}\n\\graphicspath{{./assets/}}');
  }
  return tex;
}

function addWatermark(tex) {
  if (!tex.includes('\\usepackage{eso-pic}')) {
    tex = tex.replace('\\usepackage{graphicx}', '\\usepackage{graphicx}\n\\usepackage{eso-pic}');
  }
  return tex.replace('\\begin{document}', `\\begin{document}
\\AddToShipoutPictureFG*{\\AtPageCenter{\\makebox(0,0){\\resizebox{1.2\\paperwidth}{!}{\\rotatebox{35}{\\textsf{\\color{gray!35} FREE PREVIEW}}}}}}`);
}

async function runTectonic(texPath, outDir) {
  await pexec('tectonic', ['--keep-logs', '--synctex', '--outdir', outDir, texPath], { cwd: path.dirname(texPath) });
}

function latex(s='') {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%$#&_^{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}');
}
const replaceAll = (t,k,v)=> t.split(k).join(v);

async function readJSON(key) {
  const { data, error } = await supa.storage.from('projects').download(key.replace('projects/',''));
  if (error) throw new Error('READ_JSON_FAILED: '+error.message);
  return JSON.parse(await data.text());
}

async function downloadTo(destPath, bucketAndKey) {
  const [bucket, ...rest] = bucketAndKey.split('/');
  const key = rest.join('/');
  const { data, error } = await supa.storage.from(bucket).download(key);
  if (error) throw new Error('DOWNLOAD_FAILED: '+bucketAndKey);
  await fs.writeFile(destPath, Buffer.from(await data.arrayBuffer()));
}

async function uploadFrom(bucketAndKey, srcPath, mime) {
  const [bucket, ...rest] = bucketAndKey.split('/');
  const key = rest.join('/');
  const buf = await fs.readFile(srcPath);
  const { error } = await supa.storage.from(bucket).upload(key, buf, { contentType: mime, upsert: true });
  if (error) throw new Error('UPLOAD_FAILED: '+bucketAndKey);
}

async function updateJob(id, patch) {
  await supa.from('render_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
}

const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
main().catch(e=>{ console.error(e); process.exit(1); });
