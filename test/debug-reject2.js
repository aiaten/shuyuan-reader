'use strict';
const { probe } = require('../src/source/probe');
const s = {
  bookSourceName: 'x',
  bookSourceUrl: 'https://www.zuizhong.net/',
  searchUrl: 'https://www.zuizhong.net/search.html,{"method":"POST","body":"s={{key}}"}',
  ruleSearch: { bookList: '.this-class-does-not-exist-xyz', name: 'a@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '.nope@a' },
  ruleContent: { content: '.nope@text' },
};
probe(s, { keyword: '剑' }).then((r) => {
  console.log(JSON.stringify({ search: r.stages.search, explore: r.stages.explore, details: r.details, diag: r.diagnostics }, null, 1));
}).catch((e) => console.error(e));
