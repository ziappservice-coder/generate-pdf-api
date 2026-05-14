// ============================================================
//  母堂申請表 PDF 產生 API  ─  Vercel Serverless Function
//  流程：
//    1. 讀取 repo 內的 template.docx
//    2. docxtemplater 填入欄位
//    3. 上傳填好的 DOCX 到 Service Account 的 Drive（轉 Google Doc）
//    4. 匯出為 PDF
//    5. 上傳 PDF 到 Drive，設定公開連結
//    6. 回寫 Glide
// ============================================================

import { google }    from 'googleapis';
import Docxtemplater from 'docxtemplater';
import PizZip        from 'pizzip';
import { Readable }  from 'stream';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── API Key 驗證 ───────────────────────────────────────────
  const body       = req.body || {};
  const requestKey = req.headers['x-api-key'] || body.apiKey || '';

  if (process.env.API_KEY && requestKey !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (!body.rowID) {
    return res.status(400).json({ success: false, error: 'rowID is required' });
  }

  // ── 環境變數檢查 ───────────────────────────────────────────
  const requiredEnvs = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GLIDE_API_TOKEN', 'GLIDE_APP_ID', 'GLIDE_TABLE_NAME'];
  const missingEnvs  = requiredEnvs.filter(k => !process.env[k]);
  if (missingEnvs.length > 0) {
    return res.status(500).json({ success: false, error: `缺少環境變數：${missingEnvs.join(', ')}` });
  }

  try {
    // ── Step 1：讀取並填入 DOCX 範本 ──────────────────────────
    console.log('[1] 讀取 DOCX 範本...');
    const templatePath   = join(__dirname, 'template', 'template.docx');
    const templateBuffer = readFileSync(templatePath);

    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks:    true,
      delimiters:    { start: '{{', end: '}}' },
    });

    // 欄位對應（未提供的欄位填空字串）
    const fields = [
      'Paper_Send_Date', 'Unit',    'Temple_NO',
      'Master_Name',     'Master_Male', 'Master_BD', 'Master_TD', 'Master_CD',
      'Sub_Name',        'Sub_Male',    'Sub_BD',    'Sub_TD',    'Sub_CD',
      'Address', 'TEL1', 'TEL2',
      'JOB', 'EDU', 'SKI',
      'Open_Date', 'Open_LY', 'Open_LD',
      'Temple_Area', 'Temple_Name', 'Temple_Name2',
      'ApplyMan', 'TaoMaster', 'TaoMasterLeader', 'Approve_Sign',
      'Vitae', 'Check1', 'Check2',
    ];
    const data = {};
    fields.forEach(k => {
      data[k] = (body[k] !== undefined && body[k] !== null) ? String(body[k]) : '';
    });

    doc.render(data);
    const filledBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    console.log('[1] DOCX 填入完成，大小:', filledBuffer.length, 'bytes');

    // ── Step 2：Google Auth（Service Account）──────────────────
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth        = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
      ],
    });
    const drive = google.drive({ version: 'v3', auth });

    // ── Step 2.5：清除舊檔案（釋放空間）─────────────────────────
    console.log('[2] 清除舊檔案...');
    try {
      const listRes = await drive.files.list({
        q:      `name contains '母堂申請表'`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });
      const oldFiles = listRes.data.files || [];
      console.log(`[2] 找到 ${oldFiles.length} 個舊檔案，清除中...`);
      for (const f of oldFiles) {
        await drive.files.delete({ fileId: f.id });
        console.log('[2] 已刪除:', f.name);
      }
    } catch (cleanErr) {
      console.warn('[2] 清除舊檔案失敗（不影響流程）:', cleanErr.message);
    }

    // ── Step 3：上傳 DOCX → 轉為 Google Doc ───────────────────
    const masterName  = body.Master_Name || 'unknown';
    const timestamp   = new Date()
                        .toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
                        .replace(/[/:]/g, '-').replace(/\s/g, '_');
    const docName     = `母堂申請表_${masterName}_${timestamp}`;

    console.log('[2] 上傳 DOCX 並轉為 Google Doc...');
    const uploadRes = await drive.files.create({
      requestBody: {
        name:     docName,
        mimeType: 'application/vnd.google-apps.document',  // 轉為 Google Doc
      },
      media: {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body:     Readable.from(filledBuffer),
      },
    });
    const tempDocId = uploadRes.data.id;
    console.log('[2] Google Doc ID:', tempDocId);

    // ── Step 4：匯出為 PDF ─────────────────────────────────────
    console.log('[3] 匯出 PDF...');
    const pdfRes    = await drive.files.export(
      { fileId: tempDocId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(pdfRes.data);

    // ── Step 5：上傳 PDF 到 Drive ─────────────────────────────
    const pdfName       = `${docName}.pdf`;
    const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER_ID || null;

    console.log('[4] 上傳 PDF:', pdfName);
    const pdfUploadRes = await drive.files.create({
      requestBody: {
        name:     pdfName,
        mimeType: 'application/pdf',
        parents:  OUTPUT_FOLDER ? [OUTPUT_FOLDER] : undefined,
      },
      media: {
        mimeType: 'application/pdf',
        body:     Readable.from(pdfBuffer),
      },
    });
    const pdfId = pdfUploadRes.data.id;

    // ── Step 6：設定公開連結 ───────────────────────────────────
    await drive.permissions.create({
      fileId:      pdfId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // ── Step 7：刪除暫存 Google Doc ───────────────────────────
    await drive.files.delete({ fileId: tempDocId });
    console.log('[5] 暫存 Google Doc 已刪除');

    // ── 結果 ──────────────────────────────────────────────────
    const result = {
      success:     true,
      fileId:      pdfId,
      fileName:    pdfName,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${pdfId}`,
      viewUrl:     `https://drive.google.com/file/d/${pdfId}/view`,
    };

    // ── Step 8：回寫 Glide ────────────────────────────────────
    console.log('[6] 回寫 Glide, rowID:', body.rowID);
    const glideRes = await fetch(
      'https://api.glideapp.io/api/function/mutateTables',
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.GLIDE_API_TOKEN}`,
        },
        body: JSON.stringify({
          appID: process.env.GLIDE_APP_ID,
          mutations: [{
            kind:      'set-columns-in-row',
            tableName: process.env.GLIDE_TABLE_NAME,
            rowID:     body.rowID,
            columnValues: {
              genApplyPDF: result.downloadUrl,
              APIResponse: JSON.stringify(result),
            },
          }],
        }),
      }
    );
    console.log('[6] Glide 回應:', glideRes.status);

    return res.status(200).json({ ...result, glideWritten: glideRes.ok });

  } catch (err) {
    console.error('[致命錯誤]', err.message);
    console.error(err.stack);
    return res.status(500).json({ success: false, error: err.message });
  }
}
