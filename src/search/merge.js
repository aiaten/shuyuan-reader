'use strict';
/**
 * 跨源聚合去重：把各源的搜索结果按「书名 + 作者」合并成一条书，来源挂到 offers。
 *
 * 抽成独立文件的原因：
 *  1. app.js 已经很大，聚合逻辑是纯函数，单独放便于直接单测（GUI 也用同一份）；
 *  2. electron 渲染层没有 path/fs，但需要复用同一套归一规则，所以这里不能依赖 node 内置。
 */

/** 书名归一：去掉空白/标点/常见括注后缀，用于跨源判断是不是同一本书 */
function normTitle(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')   // 去掉「（完结）」「[精校版]」这类括注
    .replace(/[·・:：\-—_.,，。!！?？'"“”‘’《》<>]/g, '')
    .toLowerCase();
}

/** 作者归一：同样去空白与标点 */
function normAuthor(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[·・:：\-—_.,，。]/g, '').toLowerCase();
}

/**
 * 把各源的搜索结果聚合成书条目。
 *
 * 同一本书在多个源里都搜到时合并成**一条**，各来源挂在 `offers` 上，
 * 用户可以从里面挑一个源加入书架（某个源失效时可以直接换源）。
 * 排序：来源数多的优先 → 书名按中文序（结果稳定）。
 *
 * @param {Array<{key:string,name:string,ok:boolean,list:Array}>} results 各源结果
 * @returns {Array<object>} 聚合后的书条目
 */
function mergeBookGroups(results) {
  const map = new Map();
  for (const r of results) {
    if (!r || !r.ok) continue;
    for (const b of r.list || []) {
      const title = b.name || '';
      if (!title) continue;
      const author = b.author || '';
      const ka = normAuthor(author);
      const kt = normTitle(title);
      // 有作者用「书名+作者」；无作者退化成「书名+来源」，避免不同源的同名书被并成一本
      const gk = ka ? `${kt}\u0000${ka}` : `${kt}\u0000@${r.key}`;
      let g = map.get(gk);
      if (!g) {
        g = {
          title,
          author,
          intro: b.intro || '',
          kind: b.kind || '',
          coverUrl: b.coverUrl || '',
          lastChapter: b.lastChapter || '',
          offers: [],
        };
        map.set(gk, g);
      }
      // 补全缺失字段（后到的源可能恰好有简介/封面）
      if (!g.intro && b.intro) g.intro = b.intro;
      if (!g.kind && b.kind) g.kind = b.kind;
      if (!g.coverUrl && b.coverUrl) g.coverUrl = b.coverUrl;
      if (!g.lastChapter && b.lastChapter) g.lastChapter = b.lastChapter;
      if (!g.author && author) g.author = author;

      g.offers.push({
        sourceKey: r.key,
        sourceName: r.name,
        bookUrl: b.bookUrl || '',
        name: b.name || '',
        author: b.author || '',
        lastChapter: b.lastChapter || '',
        kind: b.kind || '',
        coverUrl: b.coverUrl || '',
        intro: b.intro || '',
      });
    }
  }
  const out = [...map.values()];
  for (const g of out) {
    g.sourceCount = g.offers.length;
    g.best = g.offers[0]; // 默认选第一个来源，界面可切换
  }
  return out.sort((a, b) => b.sourceCount - a.sourceCount || a.title.localeCompare(b.title, 'zh'));
}

module.exports = { mergeBookGroups, normTitle, normAuthor };
