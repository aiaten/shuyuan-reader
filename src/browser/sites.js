'use strict';
/**
 * 内置浏览器——预置站点表。
 *
 * 只收录**正版付费阅读站**（用户点名的那批），本表纯数据、不发任何请求：
 * 软件只负责把用户送到站点的官方页面，登录、订阅、阅读都在站点自己的
 * 网页里完成。本软件**不抓取付费正文、不绕过付费墙**（见 POLICY 文案）。
 *
 * 字段：
 *   key   稳定标识（IPC 参数、书签去重都用它）
 *   name  显示名
 *   url   入口地址（打开站点时默认加载这个）
 *   home  站点主域（用于界面展示与「回首页」）
 *   desc  一句话说明
 */

/** 合规提示：界面上必须显示这一句（多处复用，集中在这里免得改漏）。 */
const POLICY = '仅供浏览正版内容，本软件不抓取付费正文，也不绕过任何付费门槛。';

/**
 * 预置站点。顺序即界面上的按钮顺序，按用户点名的顺序放。
 * 地址都是各站官方主域，不带任何参数；站点若改版换域，改这里即可。
 */
const SITES = [
  {
    key: 'qidian',
    name: '起点中文网',
    url: 'https://www.qidian.com/',
    home: 'https://www.qidian.com',
    desc: '阅文旗下付费阅读站，男频为主',
  },
  {
    key: 'feilu',
    name: '飞卢小说网',
    url: 'https://b.faloo.com/',
    home: 'https://b.faloo.com',
    desc: '飞卢中文网，同人/爽文向付费阅读',
  },
  {
    key: 'ciweimao',
    name: '刺猬猫阅读',
    url: 'https://www.ciweimao.com/',
    home: 'https://www.ciweimao.com',
    desc: '刺猬猫阅读，轻小说向付费阅读',
  },
  {
    key: 'boluobao',
    name: '菠萝包轻小说',
    url: 'https://book.sfacg.com/',
    home: 'https://book.sfacg.com',
    desc: 'SF 轻小说（菠萝包）付费阅读',
  },
  {
    key: 'jjwxc',
    name: '晋江文学城',
    url: 'https://www.jjwxc.net/',
    home: 'https://www.jjwxc.net',
    desc: '晋江文学城，女性向付费阅读站',
  },
];

/** 按键取站点，找不到返回 null（不抛异常，交给调用方决定提示） */
function getSite(key) {
  const k = String(key == null ? '' : key).trim().toLowerCase();
  if (!k) return null;
  return SITES.find((s) => s.key === k) || null;
}

/** 返回站点表的深拷贝，避免调用方（渲染进程）把共享常量改掉 */
function listSites() {
  return SITES.map((s) => ({ ...s }));
}

module.exports = { SITES, POLICY, listSites, getSite };
