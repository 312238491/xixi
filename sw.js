/* 溪溪的日常记录 —— 离线缓存 Service Worker
 *
 * 策略：cache-first（有缓存就完全不联网）
 *   - 有缓存：直接返回本机缓存 → 秒开、可离线
 *   - 无缓存：走网络加载并写入缓存（首次访问）
 *
 * 页面内容不做任何自动更新。需要新版时，由页面里的「更新版本」手动触发：
 * 页面把最新链接（带 token）发给本 SW，SW 自行抓取，
 *   成功 → 替换缓存，页面刷新后即为新版；
 *   失败 → 保留原缓存，不会把应用搞挂。
 *
 * 数据保存在 localStorage，与页面缓存互不相干，更新不会丢数据。
 */

/* 缓存名刻意保持稳定：更换策略时也不会清掉用户已有的页面缓存 */
var VERSION = 'v1';
var CACHE   = 'xixi-' + VERSION;
var PAGE    = new URL('index.html', self.location).href;

/* 除页面外还需要能离线使用的同目录资源。
 * 它们不带 token（相对地址解析后 query 会被丢掉），预览链接一过期就会 401，
 * 所以首次加载成功时一并缓存，之后和页面一样缓存优先。 */
var ASSETS     = ['sync.js', 'icon.png'];
var ASSET_KEYS = ASSETS.map(function(n){ return new URL(n, PAGE).href; });

/* 安装：不预缓存（避免无 token 请求失败、或把 401 页存进来），直接进入等待 */
self.addEventListener('install', function(){
  self.skipWaiting();
});

/* 激活：清掉非当前版本的缓存、预取资源，并立即接管页面 */
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function(){ return warmAssets(); })
      .then(function(){ return self.clients.claim(); })
  );
});

/* —— Safari（WebKit）兼容 ——
 * 交给导航请求的响应必须是「干净」的 HTML：
 *   - 带跳转痕迹、或 URL 与请求不一致的响应，WebKit 会直接拒绝渲染，
 *     报「Safari 打不开该网页」（首次访问不受影响，刷新时才暴露，
 *     因为刷新时 SW 才开始接管导航请求）；
 *   - 纯文本响应（旧版的 503 提示）也不能作为网页渲染。
 * 所以统一：取到 HTML 文本后重新包成一个干净的 200 响应再交出。 */
function htmlResponse(body){
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* 网络 / 缓存都不可用时给一份能正常显示的说明页，而不是 Safari 的报错页 */
function offlinePage(){
  return htmlResponse(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>暂时打不开</title></head>' +
    '<body style="font-family:-apple-system,\'PingFang SC\',sans-serif;color:#3b4657;' +
    'padding:56px 24px;text-align:center;line-height:1.9">' +
    '<h2 style="font-weight:600;font-size:18px;margin:0 0 10px">暂时打不开这个页面</h2>' +
    '<p style="color:#8a97a8;font-size:14px;margin:0">当前访问链接可能已失效（预览链接有效期 3 小时）。<br>' +
    '请回控制台点「预览」生成新链接后重试。</p></body></html>'
  );
}

/* 重新包一个干净的 200 响应（只保留类型头），避免跳转痕迹影响缓存 / 渲染 */
function cleanResponse(res, buf){
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'no-store'
    }
  });
}

/* 页面：缓存优先；首次访问走网络取 HTML 文本，成功才写入缓存 */
function servePage(req){
  return caches.open(CACHE).then(function(cache){
    return cache.match(PAGE).then(function(cached){
      if(cached){
        /* 有缓存：取出 HTML 重新包一遍，抹掉缓存条目自带的跳转 / URL 痕迹 */
        return cached.text().then(htmlResponse);
      }

      return fetch(req).then(function(res){
        if(!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
        return res.text();
      }).then(function(txt){
        cache.put(PAGE, htmlResponse(txt));
        return htmlResponse(txt);
      }).catch(offlinePage);
    });
  }).catch(offlinePage);   /* 缓存不可用（如无痕模式）也不能让导航失败 */
}

/* 资源（sync.js / 图标）：同样缓存优先，首次成功加载时写入 */
function serveAsset(req){
  return caches.open(CACHE).then(function(cache){
    return cache.match(req.url).then(function(cached){
      if(cached) return cached;
      return fetch(req).then(function(res){
        if(!res || !res.ok) return res;      /* 401 等不写入，原样交给浏览器 */
        return res.arrayBuffer().then(function(buf){
          var clean = cleanResponse(res, buf);
          cache.put(req.url, clean.clone());
          return clean;
        });
      });
    });
  });
}

/* 接管页面与本表资源的请求；sw.js 等其它请求直接走网络 */
self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;

  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;
  if(/\/sw\.js$/i.test(url.pathname)) return;

  /* 带预览 token 的导航一律交给浏览器原生处理（不拦、不读缓存）：
   * 只有真正请求到服务器，才会发生 302 跳转并下发 eo_token / eo_time Cookie。
   * 一旦被 SW 用缓存拦下，Cookie 就写不进去，之后所有请求都会 401。 */
  if(req.mode === 'navigate' && /[?&]eo_token=/i.test(url.search)) return;

  var isPage  = req.mode === 'navigate' || url.pathname === '/' || /\.html?$/i.test(url.pathname);
  var isAsset = ASSET_KEYS.indexOf(url.href) >= 0;
  if(!isPage && !isAsset) return;

  e.respondWith(isPage ? servePage(req) : serveAsset(req));
});

/* 预取资源（sync.js / 图标）。激活时页面刚带 token 访问过，cookie 已就绪，
 * 一般能取到；取不到就静默跳过，等页面真正请求时再补。
 * 图标这类资源浏览器常复用自身缓存、不会让 SW 看到，所以需要主动预取一次。 */
function warmAssets(){
  return caches.open(CACHE).then(function(cache){
    return Promise.all(ASSET_KEYS.map(function(u){ return refreshAsset(cache, u); }));
  }).catch(function(){});
}

/* 更新版本时把资源也刷新一遍；某个资源拿不到就保留旧缓存，不影响更新结果 */
function refreshAsset(cache, assetUrl){
  return fetch(assetUrl, { cache: 'no-store' }).then(function(res){
    if(!res || !res.ok) return null;
    return res.arrayBuffer().then(function(buf){
      return cache.put(assetUrl, cleanResponse(res, buf));
    });
  }).catch(function(){ return null; });
}

/* 手动更新：SW 内部的 fetch 不会被自己的 fetch 事件拦截，可以直接拿到新版本 */
self.addEventListener('message', function(e){
  var d = e.data || {};
  if(d.type !== 'UPDATE' || !d.url) return;

  var src = e.source;
  var reply = function(ok){
    if(src) src.postMessage({ type: 'UPDATE_RESULT', ok: ok });
  };

  var target;
  try{ target = new URL(d.url, self.location.href); }catch(err){ reply(false); return; }
  if(target.origin !== self.location.origin){ reply(false); return; }

  fetch(target.href, { cache: 'no-store' }).then(function(res){
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    if(!res.ok || ct.indexOf('text/html') < 0) return false;   /* 401/错误页一律不写入 */
    return res.text().then(function(txt){
      return caches.open(CACHE).then(function(c){
        /* 先存页面（这一步顺带把 cookie 续上），再刷新资源 */
        return c.put(PAGE, htmlResponse(txt))
          .then(function(){ return Promise.all(ASSET_KEYS.map(refreshAsset.bind(null, c))); });
      }).then(function(){ return true; });
    });
  }).catch(function(){
    return false;
  }).then(reply);
});
