const api = window.piikDesktop;
const $ = id => document.getElementById(id);
let noticeTimer;
function showError(error) {
  $('notice').textContent = error.message || String(error);
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
for (const action of ['home', 'back', 'reload', 'certificate', 'update']) {
  $(action).addEventListener('click', () => api[action]().catch(showError));
}
$('brand').addEventListener('click', event => { event.preventDefault(); api.home().catch(showError); });
$('retry').addEventListener('click', () => api.restart().catch(showError));
$('update-source').addEventListener('change', () => api.updateSource($('update-source').value).catch(showError));
$('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('join').disabled = true;
  try { await api.join($('invite').value); $('invite').value = ''; }
  catch (error) { showError(error); }
  finally { $('join').disabled = false; }
});
api.onState(state => {
  $('status').textContent = state.phase === 'ready' ? '服务就绪' : state.phase === 'error' ? '服务已停止' : '正在启动';
  $('dot').className = state.phase;
  $('back').disabled = !state.canGoBack;
  $('home').disabled = state.phase !== 'ready';
  $('certificate').disabled = !state.certificate;
  $('welcome').hidden = state.showPage;
  $('retry').hidden = state.phase !== 'error';
  const update = state.update;
  if (update) {
    const labels = { idle: '更新', checking: '检查中…', available: '有更新', downloading: update.progress === null ? '下载中…' : `下载 ${update.progress || 0}%`, verifying: '验证中…', ready: '重启更新', current: '更新', error: '重试更新' };
    $('update').textContent = labels[update.phase] || '更新';
    $('update').disabled = ['checking', 'downloading', 'verifying'].includes(update.phase);
    $('update-source').disabled = $('update').disabled;
    $('update-source').value = update.updateSource || 'auto';
    $('update').classList.toggle('available', ['available', 'ready'].includes(update.phase));
    $('update').title = update.message || `当前 Piik ${update.currentVersion}${update.latestVersion ? `\n最新正式版 ${update.latestVersion}` : '\n检查所选更新源的正式发布版'}`;
  }
  if (state.phase === 'error') {
    $('headline').textContent = '暂时没能打开房间';
    $('message').textContent = state.error;
  } else if (state.phase === 'starting') {
    $('headline').innerHTML = '朋友的放映室，<br>现在就在桌面。';
    $('message').textContent = '正在准备屏幕分享和房间语音…';
  }
});
api.ready();
