/* sync.js —— 家庭日常记录 · 共用的云端同步模块
 *
 * 多多和溪溪两个页面引用同一份，只保留一份易出错的传输/队列/合并逻辑。
 * 它不认识「奶量」「臭臭」这些东西，只负责：
 *   - 请求（anon key 走 apikey，schema 走 Profile 头，带 8 秒超时）
 *   - 待推送队列（同一个 id 只留最新一条，分批 200 条 upsert）
 *   - 墓碑（本机删掉的 id，防止被别的手机的旧数据拉回来）
 *   - 拉取全量（按 app 过滤 + Range 翻页）并交给页面合并
 *   - 项目类别表（duoduo_items）的读写，两个页面共用
 *   - 进度鼓励文案表（duoduo_sayings）的只读拉取（只有溪溪启用，多多不填即关闭）
 *
 * 页面负责的（只有它知道自己的数据形状）：
 *   rowFrom / applyRow / allRows / seedItems / getData / setData / ...
 *
 * 数据放在两处：
 *   本机 localStorage —— 唯一的数据来源，离线可用、秒开
 *   云端 PostgreSQL    —— 多台手机共用的中转站
 */
(function(global){
  'use strict';

  function readJSON(key, dflt){
    try{
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : dflt;
    }catch(e){ return dflt; }
  }
  function writeJSON(key, val){
    try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
  }
  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function nowTime(){
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function create(cfg){
    var APP     = cfg.app;                    /* 云端 app 列：'duoduo' / 'xixi' */
    var URL     = cfg.url;
    var KEY     = cfg.key;
    var SCHEMA  = cfg.schema || 'public';
    var TABLE   = cfg.table;                  /* 记录表 */
    var ITEMS   = cfg.itemsTable;             /* 项目类别表 */
    var TIMEOUT = cfg.timeout || 8000;        /* 单次请求上限(ms) */
    var BATCH   = 200;                        /* 每次推送的行数上限 */
    var PAGE_SIZE = 1000;                     /* 接口单次最多返回的行数 */
    var SAY       = !!cfg.itemSayFields;      /* 项目表是否带「朗读开关 + 朗读文案」两个字段 */
    var EXCL      = !!cfg.itemExclField;      /* 项目表是否带「互斥组」字段 */
    var SPAN      = !!cfg.itemSpanField;      /* 项目表是否带「卡片宽度」字段 */
    var SAYTBL    = cfg.sayingsTable || '';   /* 进度鼓励文案表（不填 = 不启用，多多不填） */
    var K = cfg.keys || {};

    /* PostgREST 批量插入要求同一批所有行的字段完全一致。
     * 旧版页面排进队列的行缺字段键（喂奶没有 level、勾选/臭臭没有 bml），
     * 新旧混批会整批 400 卡死队列，这里启动时统一补齐缺失的字段。 */
    function normalizePendingRow(r){
      if(r && typeof r === 'object'){
        if(!('level' in r)) r.level = null;
        if(!('ml'   in r)) r.ml   = null;
        if(!('bml'  in r)) r.bml  = null;
      }
      return r;
    }

    var tombstones     = readJSON(K.tomb, {});        /* 删掉的记录 id */
    var itemTombstones = readJSON(K.tombItems, {});   /* 删掉的项目 id */
    var recPending     = readJSON(K.pending, []).map(normalizePendingRow);   /* 还没推上去的记录行 */
    var itemPending    = readJSON(K.pendingItems, []).map(function(r){
      /* 后加的字段：旧队列里的行缺这个键会让整批 upsert 报 400，先补齐 */
      if(SPAN && r && typeof r === 'object' && !('card_span' in r)) r.card_span = 0;
      return r;
    });                                               /* 还没推上去的项目行 */
    /* 进度鼓励文案：整表从云端拉下来缓存到本机（只读、不回传；只有溪溪用） */
    var sayingsCache   = (SAYTBL && K.sayings) ? readJSON(K.sayings, []) : [];
    if(!Array.isArray(sayingsCache)) sayingsCache = [];

    var recSyncing  = false;
    var itemSyncing = false;
    var lastPull    = 0;
    var hadAnyItemRows = false;   /* 本次拉取云端是否返回过项目行（用来判断要不要播种） */
    var hadAnyRecRows  = false;   /* 本次拉取云端是否返回过记录行（用来判断要不要补传） */

    function setState(txt, cls){
      var el = document.getElementById('syncState');
      if(el){ el.textContent = txt; el.className = cls || ''; }
    }

    /* ---------------- 请求：anon key + Profile 头 + 超时 ---------------- */
    function sbFetch(table, opts){
      opts = opts || {};
      var h = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };
      if(opts.body) h['Content-Type'] = 'application/json';
      /* 读用 Accept-Profile，写用 Content-Profile，告诉接口去哪个 schema */
      h[opts.method && opts.method !== 'GET' ? 'Content-Profile' : 'Accept-Profile'] = SCHEMA;
      if(opts.prefer) h['Prefer'] = opts.prefer;
      if(opts.range)  h['Range']  = opts.range;

      /* 超时保护：网络卡住时不再无限等待，到点直接中断 */
      var ctl   = global.AbortController ? new AbortController() : null;
      var timer = ctl ? setTimeout(function(){ ctl.abort(); }, TIMEOUT) : null;
      function stop(){ if(timer){ clearTimeout(timer); timer = null; } }

      return fetch(URL + '/rest/v1/' + table + (opts.query || ''), {
        method:  opts.method || 'GET',
        headers: h,
        body:    opts.body,
        signal:  ctl ? ctl.signal : undefined
      }).then(function(res){
        if(!res.ok){
          return res.text().then(function(t){
            throw new Error('HTTP ' + res.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 200));
          });
        }
        return res.text().then(function(t){
          if(!t) return [];                        /* 推送成功时是空响应体，不是 JSON */
          try{ return JSON.parse(t); }catch(e){ return []; }
        });
      }).then(function(v){
        stop();
        return v;
      }, function(err){
        stop();
        if(err && err.name === 'AbortError') throw new Error('请求超时（' + TIMEOUT + 'ms）');
        throw err;
      });
    }

    /* ---------------- 项目类别（两个页面共用一套结构） ---------------- */
    /* 项目 id 在云端统一带 app 前缀。
     * 两个页面的项目存同一张表，多多的「维生素AD」和溪溪的「维生素AD」
     * 本机 id 都叫 vitaminAD；主键只有 id 时它们会互相覆盖，导致后传的那个被吞掉。
     * 前缀只活在网络层，页面里的 id 与导出的数据仍是干净的短 id。 */
    function wireId(id){ return APP + ':' + id; }
    function localId(id){
      var p = APP + ':';
      return String(id).indexOf(p) === 0 ? String(id).slice(p.length) : String(id);
    }

    function rowFromItem(item, deleted, u){
      var row = {
        id:     wireId(item.id),
        app:    APP,
        name:   item.name,
        count:  item.count > 0 ? item.count : 1,
        sort:   item.sort || 0,
        deleted: !!deleted,
        updated_at: new Date(u || Date.now()).toISOString()
      };
      /* 朗读设置（只有带该字段的页面才写，避免影响老页面） */
      if(SAY){ row.say = !!item.say; row.say_text = item.sayText || ''; }
      /* 互斥组（同一天同组只能勾一个；只有带该字段的页面才写） */
      if(EXCL){ row.excl_group = item.exclGroup || ''; }
      /* 卡片宽度（0=自动；只有带该字段的页面才写） */
      if(SPAN){ row.card_span = (item.span >= 1 && item.span <= 4) ? Math.round(item.span) : 0; }
      return row;
    }

    /* 云端一行 → 合并进本机项目列表；列表是页面传进来的同一个数组，直接改 */
    function applyItemRow(r){
      var id = localId(r.id);                    /* 去掉 app 前缀，还原成页面里的短 id */
      if(itemTombstones[id]) return false;
      var u    = Date.parse(r.updated_at) || 0;
      var list = cfg.getItems();
      var cur  = null;
      for(var i = 0; i < list.length; i++){ if(list[i].id === id){ cur = list[i]; break; } }

      if(r.deleted){
        if(cur && (cur.u || 0) <= u){ list.splice(list.indexOf(cur), 1); return true; }
        return false;
      }
      if(cur){
        if((cur.u || 0) >= u) return false;      /* 本机这份更新 → 保留本机 */
        cur.name  = r.name;
        cur.count = r.count > 0 ? r.count : 1;
        cur.sort  = r.sort || 0;
        if(SAY){ cur.say = !!r.say; cur.sayText = r.say_text || ''; }
        if(EXCL){ cur.exclGroup = r.excl_group || ''; }
        if(SPAN){ cur.span = (r.card_span >= 1 && r.card_span <= 4) ? Math.round(r.card_span) : 0; }
        cur.u     = u;
        return true;
      }
      var fresh = { id:id, name:r.name, count: r.count > 0 ? r.count : 1, sort: r.sort || 0, u:u };
      if(SAY){ fresh.say = !!r.say; fresh.sayText = r.say_text || ''; }
      if(EXCL){ fresh.exclGroup = r.excl_group || ''; }
      if(SPAN){ fresh.span = (r.card_span >= 1 && r.card_span <= 4) ? Math.round(r.card_span) : 0; }
      list.push(fresh);
      return true;
    }

    function sortItems(){
      var list = cfg.getItems();
      list.sort(function(a, b){
        if((a.sort || 0) !== (b.sort || 0)) return (a.sort || 0) - (b.sort || 0);
        return (a.u || 0) - (b.u || 0);
      });
    }

    /* ---------------- 待推送队列 ---------------- */
    /* 排队待推送：同一个 id 只保留最新一条；silent 用于批量导入不进逐条推送 */
    function queueRow(row, silent){
      row.app = APP;    /* 统一补 app：记录行由各页面拼装，漏写会被库默认值顶成别人的 app */
      for(var i = recPending.length - 1; i >= 0; i--){
        if(recPending[i].id === row.id) recPending.splice(i, 1);
      }
      recPending.push(row);
      writeJSON(K.pending, recPending);
      if(!silent) pushPending();
    }

    function queueItemRow(row, silent){
      for(var i = itemPending.length - 1; i >= 0; i--){
        if(itemPending[i].id === row.id) itemPending.splice(i, 1);
      }
      itemPending.push(row);
      writeJSON(K.pendingItems, itemPending);
      if(!silent) pushItemPending();
    }

    /* 两个队列都空了才算同步完成 */
    function maybeIdle(){
      if(recSyncing || itemSyncing) return;
      if(recPending.length || itemPending.length) return;
      setState('☁ 已同步 ' + nowTime(), 'ok');
    }

    /* 推送：分批 upsert（冲突按 id 覆盖）。
     * 分批是必须的：首次同步会把全部历史记录排进队列，
     * 若一次性塞进一个请求，记录一多就容易超时，而且失败后整批重试、永远过不去。 */
    function pushPending(){
      if(recSyncing || !recPending.length) return;
      var sent = recPending.slice(0, BATCH);
      recSyncing = true;
      setState('☁ 同步中…' + (recPending.length > BATCH ? '（共 ' + recPending.length + ' 条）' : ''), 'busy');

      sbFetch(TABLE, {
        method: 'POST',
        query:  '?on_conflict=id',                 /* id 冲突时覆盖，即 upsert */
        prefer: 'resolution=merge-duplicates,return=minimal',
        body:   JSON.stringify(sent)
      }).then(function(){
        /* 只清掉这批（按对象引用比对，期间新排进来的不受影响） */
        recPending = recPending.filter(function(r){ return sent.indexOf(r) < 0; });
        writeJSON(K.pending, recPending);
        recSyncing = false;
        if(recPending.length){ pushPending(); return; }   /* 还有剩余，接着传下一批 */
        maybeIdle();
      }).catch(function(err){
        recSyncing = false;
        setState('☁ 未同步（' + recPending.length + ' 条待传，点「立即同步」重试）', 'err');
        console.warn('[同步] 推送失败：', err.message || err);
      });
    }

    function pushItemPending(){
      if(itemSyncing || !itemPending.length) return;
      var sent = itemPending.slice(0, BATCH);
      itemSyncing = true;
      setState('☁ 同步中…', 'busy');

      sbFetch(ITEMS, {
        method: 'POST',
        query:  '?on_conflict=id',       /* 云端 id 已带 app 前缀，全局唯一，按 id 覆盖即可 */
        prefer: 'resolution=merge-duplicates,return=minimal',
        body:   JSON.stringify(sent)
      }).then(function(){
        itemPending = itemPending.filter(function(r){ return sent.indexOf(r) < 0; });
        writeJSON(K.pendingItems, itemPending);
        itemSyncing = false;
        if(itemPending.length){ pushItemPending(); return; }
        maybeIdle();
      }).catch(function(err){
        itemSyncing = false;
        setState('☁ 未同步（' + itemPending.length + ' 个项目待传，点「立即同步」重试）', 'err');
        console.warn('[同步] 项目推送失败：', err.message || err);
      });
    }

    /* ---------------- 项目增删（页面改完自己的 items 后调这两个） ---------------- */
    function pushItem(item){
      if(itemTombstones[item.id]) return;
      queueItemRow(rowFromItem(item, false, item.u || Date.now()));
    }

    /* 删除项目：本机已从 items 移除后调用；云端该行置 deleted=true，历史勾选记录保留不显示 */
    function removeItem(item){
      itemTombstones[item.id] = true;
      writeJSON(K.tombItems, itemTombstones);
      for(var i = itemPending.length - 1; i >= 0; i--){
        if(itemPending[i].id === item.id) itemPending.splice(i, 1);
      }
      queueItemRow(rowFromItem(item, true, Date.now()));
    }

    /* ---------------- 进度鼓励文案（只读） ---------------- */
    /* 文案在数据库里维护，页面只管读下来缓存；拉取失败不影响记录同步。 */
    function pullSayings(){
      if(!SAYTBL) return Promise.resolve(false);
      return sbFetch(SAYTBL, {
        method: 'GET',
        query:  '?app=eq.' + encodeURIComponent(APP) + '&order=stage.asc,sort.asc,id.asc'
      }).then(function(rows){
        var out = [];
        (rows || []).forEach(function(r){
          if(!r || r.deleted) return;
          out.push({ stage: r.stage, text: r.text, sort: r.sort || 0 });
        });
        sayingsCache = out;
        if(K.sayings) writeJSON(K.sayings, sayingsCache);
        return true;
      }).catch(function(err){
        console.warn('[同步] 鼓励文案拉取失败：', err.message || err);
        return false;
      });
    }

    /* ---------------- 拉取云端全量并合并 ---------------- */
    /* 接口默认一次最多返回 1000 行，所以按 Range 翻页拿完，
     * 否则记录攒到 1000 条以上就会悄悄同步不全。 */
    function pullRecords(){
      var all = [];
      function step(from){
        var opts = { method:'GET', query:'?app=eq.' + encodeURIComponent(APP) + '&order=id.asc' };
        /* 第一页不发 Range，避免多一次跨域预检；超过一页才翻 */
        if(from > 0) opts.range = from + '-' + (from + PAGE_SIZE - 1);
        return sbFetch(TABLE, opts).then(function(rows){
          rows = rows || [];
          all = all.concat(rows);
          if(rows.length < PAGE_SIZE) return all;
          return step(from + PAGE_SIZE);
        });
      }
      return step(0).then(function(rows){
        hadAnyRecRows = rows.length > 0;
        var changed = false;
        rows.forEach(function(r){ if(cfg.applyRow(r)) changed = true; });
        return changed;
      });
    }

    function pullItems(){
      return sbFetch(ITEMS, {
        method: 'GET',
        query:  '?app=eq.' + encodeURIComponent(APP) + '&order=id.asc'
      }).then(function(rows){
        rows = rows || [];
        hadAnyItemRows = rows.length > 0;
        var changed = false;
        rows.forEach(function(r){ if(applyItemRow(r)) changed = true; });
        if(changed) sortItems();

        /* 云端一行项目都没有、本机却有 → 是本机领先（数据库被清空过），
         * 把本机项目整份补传上去，让两边重新对齐。
         * 页面上的删除是把行标成 deleted 后继续留在表里，所以正常删除不会让云端变空，
         * 只有真的被清库才会走到这里。 */
        if(!hadAnyItemRows && cfg.getItems().length){
          var mine = cfg.getItems();
          for(var i = 0; i < mine.length; i++){
            queueItemRow(rowFromItem(mine[i], false, mine[i].u || Date.now()), true);
          }
          changed = true;
        }
        return changed;
      });
    }

    /* 首次同步：把本机已有的记录全部排进队列传上去 */
    function enqueueAll(){
      var data = cfg.getData();
      Object.keys(data).forEach(function(dayStr){
        var rows = cfg.allRows(dayStr, data[dayStr]) || [];
        rows.forEach(function(r){ queueRow(r, true); });
      });
      if(cfg.onChange) cfg.onChange();
    }

    /* ---------------- 同步入口：先拉后推 ----------------
     * 先拉项目、再拉记录：勾选记录要按项目 id 归位，
     * 项目还没合并进来的话，记录会被当成"项目不存在"丢掉。 */
    function syncNow(){
      lastPull = Date.now();
      setState('☁ 同步中…', 'busy');
      pullItems().then(function(itemChanged){
        return pullSayings().then(function(){
        return pullRecords().then(function(recChanged){
          /* 本机没有项目、云端也从没有过项目行 → 用页面给的种子初始化（并同步出去） */
          if(!cfg.getItems().length && !hadAnyItemRows && cfg.seedItems){
            var seeds = cfg.seedItems() || [];
            if(seeds.length){
              var u = Date.now();
              var list = cfg.getItems();
              seeds.forEach(function(it, i){
                it.u = it.u || u + i;           /* 用递增 u 保住播种顺序 */
                if(it.sort === undefined) it.sort = i;
                list.push(it);
              });
              sortItems();
              if(cfg.onItemsChange) cfg.onItemsChange();
              seeds.forEach(function(it){ pushItem(it); });
            }
          }
          if(recChanged || itemChanged){
            if(cfg.onChange) cfg.onChange();
          }
          /* 本机从没全量传过，或云端记录被清空了 → 把本机记录整份重新排进队列。
           * 云端一行都没有只可能是被清库（页面上删除会留下 deleted 行），
           * 这时不补传的话本机这些记录就永远上不去了，两边会一直对不上。 */
          if(localStorage.getItem(K.synced) === null || !hadAnyRecRows){
            enqueueAll();
            try{ localStorage.setItem(K.synced, '1'); }catch(e){}
          }
          if(!recPending.length && !itemPending.length){
            setState('☁ 已同步 ' + nowTime(), 'ok');
            return;
          }
          pushPending();
          pushItemPending();
        });
        });
      }).catch(function(err){
        setState('☁ 未同步（点「立即同步」重试）', 'err');
        console.warn('[同步] 拉取失败：', err.message || err);
      });
    }

    /* 切回前台时补一次（30 秒内不重复） */
    document.addEventListener('visibilitychange', function(){
      if(document.visibilityState !== 'visible') return;
      if(Date.now() - lastPull < 30000) return;
      syncNow();
    });

    return {
      now: syncNow,
      queue: function(row){ queueRow(row, false); },
      tomb: function(id){ tombstones[id] = true; writeJSON(K.tomb, tombstones); },
      isTombstoned: function(id){ return !!tombstones[id]; },
      pushItem: pushItem,
      removeItem: removeItem,
      /* 进度鼓励文案（只读缓存）：[{ stage, text, sort }, …] */
      getSayings: function(){ return sayingsCache.slice(); },
      /* 导入的是一份完整数据 → 清掉已传标记，下次同步整份重新上传（以本机为准） */
      clearSynced: function(){ try{ localStorage.removeItem(K.synced); }catch(e){} }
    };
  }

  global.FamilySync = { create: create };
})(window);
