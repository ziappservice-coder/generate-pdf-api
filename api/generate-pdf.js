// ============================================================
//  母堂申請表 PDF 產生 API  ─  Vercel Serverless Function
//  職責：
//    1. 接收 Glide 的 POST 請求
//    2. 呼叫 Google Apps Script（自動追蹤 302）產生 PDF
//    3. 將結果回寫 Glide（mutateTables）
//    4. 回傳 JSON 給 Glide
// ============================================================

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── 環境變數 ───────────────────────────────────────────────
  const APPS_SCRIPT_URL  = process.env.APPS_SCRIPT_URL;
  const APPS_SCRIPT_KEY  = process.env.APPS_SCRIPT_KEY;
  const GLIDE_API_TOKEN  = process.env.GLIDE_API_TOKEN;
  const GLIDE_APP_ID     = process.env.GLIDE_APP_ID;
  const GLIDE_TABLE_NAME = process.env.GLIDE_TABLE_NAME;
  const API_KEY          = process.env.API_KEY;           // Vercel 端的 API Key

  // ── API Key 驗證 ───────────────────────────────────────────
  const body       = req.body || {};
  const requestKey = req.headers['x-api-key'] || body.apiKey || '';

  if (API_KEY && requestKey !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // ── 必填欄位檢查 ───────────────────────────────────────────
  if (!body.rowID) {
    return res.status(400).json({ success: false, error: 'rowID is required' });
  }

  try {
    // ── Step 1：呼叫 Apps Script 產生 PDF ─────────────────────
    console.log('[1] 呼叫 Apps Script, rowID:', body.rowID);

    const scriptUrl = `${APPS_SCRIPT_URL}?apiKey=${APPS_SCRIPT_KEY}`;
    const scriptRes = await fetch(scriptUrl, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify(body),
      redirect: 'follow',            // ← 關鍵：自動追蹤 Google 的 302
    });

    if (!scriptRes.ok) {
      const errText = await scriptRes.text();
      console.error('[Apps Script 錯誤]', scriptRes.status, errText);
      throw new Error(`Apps Script 回應 ${scriptRes.status}: ${errText}`);
    }

    const pdfResult = await scriptRes.json();
    console.log('[2] PDF 產生結果:', pdfResult);

    if (!pdfResult.success) {
      throw new Error(pdfResult.error || 'Apps Script 回傳失敗');
    }

    // ── Step 2：回寫 Glide ────────────────────────────────────
    console.log('[3] 回寫 Glide, rowID:', body.rowID);

    const glidePayload = {
      appID: GLIDE_APP_ID,
      mutations: [
        {
          kind:      'set-columns-in-row',
          tableName: GLIDE_TABLE_NAME,
          rowID:     body.rowID,
          columnValues: {
            genApplyPDF:  pdfResult.downloadUrl,
            APIResponse:  JSON.stringify(pdfResult),
          },
        },
      ],
    };

    const glideRes = await fetch(
      'https://api.glideapp.io/api/function/mutateTables',
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${GLIDE_API_TOKEN}`,
        },
        body: JSON.stringify(glidePayload),
      }
    );

    const glideBody = await glideRes.text();
    console.log('[4] Glide 回應:', glideRes.status, glideBody);

    if (!glideRes.ok) {
      console.warn('[Glide 回寫失敗] Status:', glideRes.status, 'Body:', glideBody);
      // 回寫失敗不中斷流程，PDF 已產生成功
    }

    // ── Step 3：回傳給 Glide Call API ─────────────────────────
    return res.status(200).json({
      success:      true,
      fileId:       pdfResult.fileId,
      fileName:     pdfResult.fileName,
      downloadUrl:  pdfResult.downloadUrl,
      viewUrl:      pdfResult.viewUrl,
      glideWritten: glideRes.ok,
    });

  } catch (err) {
    console.error('[致命錯誤]', err.message);
    return res.status(500).json({
      success: false,
      error:   err.message,
    });
  }
}
