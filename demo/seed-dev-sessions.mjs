// 播种调试实例：3 个 workspace × 1 个会话（各带确定性标题），供实例池 e2e 使用。
const ORIGIN = 'http://127.0.0.1:3190';
const TOKEN = process.env.DSH_DEV_TOKEN;
if (!TOKEN) throw new Error('DSH_DEV_TOKEN required');

const res0 = await fetch(`${ORIGIN}/?token=${TOKEN}`, { redirect: 'manual' });
const setCookie = res0.headers.get('set-cookie');
if (!setCookie) throw new Error('token exchange failed: ' + res0.status);
const cookie = setCookie.split(';', 1)[0];

let n = 0;
const rpc = async (method, key, args) => {
  n += 1;
  const endpoint = method.split('.').join('/');
  const res = await fetch(`${ORIGIN}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `seed-${n}`,
      method: endpoint,
      payload: { args: { [key]: args } },
    }),
  });
  const text = await res.text();
  let env;
  try { env = JSON.parse(text); } catch { throw new Error(`${method}: non-JSON ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || !env.result || env.result.ok !== true) {
    throw new Error(`${method}: ${res.status} ${text.slice(0, 300)}`);
  }
  return env.result.value;
};

const targets = [
  ['/home/huangyaodong/deepseek-harness-workspace', '重构实例池弹窗与会话标题展示'],
  ['/home/huangyaodong/api-management-workspace', 'API工作流事件管理进展与后续工作'],
  ['/home/huangyaodong/cmdb-ops', 'CMDB-Ops sayhi命令历史记录去重优化方案设计'],
];

const out = [];
for (const [path, title] of targets) {
  const w = await rpc('workspace.create', 'request', { path });
  const wsId = w.workspace ? w.workspace.workspaceId : w.workspaceId;
  const s = await rpc('session.create', 'request', { workspaceId: wsId });
  const sid = s.sessionId;
  let renamed = false;
  try {
    await rpc('session.rename', 'request', { sessionId: sid, title });
    renamed = true;
  } catch (e) {
    console.log('rename attempt failed (fallback: 项目名展示):', String(e).slice(0, 160));
  }
  let prompted = false;
  try {
    await rpc('session.prompt', 'request', {
      requestId: 'seed-' + n,
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '记录：' + title }],
    });
    prompted = true;
  } catch (e) {
    console.log('prompt attempt failed:', String(e).slice(0, 160));
  }
  out.push({ path, wsId, sid, title, renamed, prompted });
}
console.log(JSON.stringify(out, null, 1));
