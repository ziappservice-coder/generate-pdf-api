// ============================================================
//  診斷 Endpoint - 測試 Service Account 連線與檔案存取
//  GET /api/diagnose
// ============================================================

import { google } from 'googleapis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const result = {
    env: {},
    auth: null,
    driveApiTest: null,
    fileAccessTest: null,
  };

  // ── 1. 檢查環境變數 ────────────────────────────────────────
  const envKeys = [
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'TEMPLATE_DOC_ID',
    'GLIDE_API_TOKEN',
    'GLIDE_APP_ID',
    'GLIDE_TABLE_NAME',
    'API_KEY',
  ];
  envKeys.forEach(k => {
    const val = process.env[k];
    result.env[k] = val
      ? (k === 'GOOGLE_SERVICE_ACCOUNT_JSON'
          ? `設定（長度 ${val.length} 字元）`
          : `設定（${val.slice(0, 20)}...）`)
      : '❌ 未設定';
  });

  // ── 2. 解析 Service Account JSON ──────────────────────────
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'undefined');
    result.auth = {
      client_email: credentials.client_email,
      project_id:   credentials.project_id,
      type:         credentials.type,
    };
  } catch (e) {
    result.auth = `❌ JSON 解析失敗：${e.message}`;
    return res.status(200).json(result);
  }

  // ── 3. 測試 Drive API（列出可存取的檔案）─────────────────
  try {
    const auth  = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
      ],
    });
    const drive = google.drive({ version: 'v3', auth });

    const listRes = await drive.files.list({
      pageSize: 5,
      fields:   'files(id, name, mimeType)',
    });

    result.driveApiTest = {
      status:           '✅ Drive API 可用',
      accessibleFiles:  listRes.data.files.map(f => ({
        id:       f.id,
        name:     f.name,
        mimeType: f.mimeType,
      })),
    };

    // ── 4. 測試目標範本檔案存取 ─────────────────────────────
    const templateId = process.env.TEMPLATE_DOC_ID
                       || '1DNW4JDp5oDw1tPwAr1Z9oMHWrKNyL3p66fxWyWWtSmk';
    try {
      const fileRes = await drive.files.get({
        fileId: templateId,
        fields: 'id, name, mimeType, owners',
      });
      result.fileAccessTest = {
        status:   '✅ 範本文件可存取',
        id:       fileRes.data.id,
        name:     fileRes.data.name,
        mimeType: fileRes.data.mimeType,
      };
    } catch (e) {
      result.fileAccessTest = {
        status:  '❌ 範本文件無法存取',
        error:   e.message,
        hint:    `請確認已將文件共用給：${credentials.client_email}（編輯者權限）`,
      };
    }

  } catch (e) {
    result.driveApiTest = `❌ Drive API 失敗：${e.message}`;
  }

  return res.status(200).json(result);
}
