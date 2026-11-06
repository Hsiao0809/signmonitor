/* signmonitor 定時觸發器（Cloudflare Worker）
   GitHub 自己的排程常延遲或不跑，改由 Cloudflare 每小時第 50 分呼叫 GitHub 啟動 Monitor。
   這個 Worker 只做一件事：觸發 Hsiao0809/signmonitor 的 monitor.yml，不碰其他 repo。

   設定：
   - Secret：GITHUB_TOKEN（GitHub fine-grained token，只授權 signmonitor，Actions: Read and write）
   - Cron Trigger：50 * * * *
*/
const REPO = 'Hsiao0809/signmonitor';
const WORKFLOW = 'monitor.yml';

async function dispatch(env) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'signmonitor-trigger'
    },
    body: JSON.stringify({ ref: 'main', inputs: { daily: 'auto' } })
  });
  if (r.status !== 204) throw new Error(`GitHub 回應 ${r.status}：${await r.text()}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  }
};
