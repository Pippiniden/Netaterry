// テンプレート管理画面・呼び出し（プレースホルダー対応）
import { store } from '../store.js';
import { addTagsTo, cleanTag } from '../tags.js';
import { h, modal, confirmDialog, toast, radioGroup, radioValue } from './dom.js';

/** テンプレート本文中の {{変数名}} を出現順・重複なしで取得 */
export function placeholders(body) {
  const seen = [];
  for (const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

export function fillTemplate(body, values, leftover = 'keep') {
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name) => {
    const v = values[name];
    if (v != null && v !== '') return v;
    return leftover === 'remove' ? '' : all;
  });
}

// ---------- 呼び出し ----------
export async function applyTemplateTo(nodeId) {
  const n = store.get(nodeId);
  if (!n) return;
  const tpl = await pickTemplate();
  if (!tpl) return;
  if (n.body.trim() !== '') {
    const ok = await confirmDialog('現在の本文は置き換えられます。\n（置き換え後も「元に戻す」で戻せます）', { ok: '置き換える', title: `テンプレート「${tpl.name}」` });
    if (!ok) return;
  }
  let body = tpl.body;
  const vars = placeholders(tpl.body);
  if (vars.length) {
    const inputs = vars.map((v) => h('input', { class: 'input', type: 'text', dataset: { v } }));
    const wrap = h('div', {},
      h('p', { class: 'muted' }, '同じ変数名は一括で反映されます。'),
      vars.map((v, i) => h('label', { class: 'field' }, h('span', {}, v), inputs[i])),
      h('h3', {}, '未入力の変数'),
      radioGroup('leftover', [['keep', '{{変数名}} のまま残す'], ['remove', '削除する']], 'keep'));
    const res = await modal({
      title: `テンプレート「${tpl.name}」の入力`,
      body: wrap,
      buttons: [{ label: 'キャンセル', value: null }, {
        label: '反映', primary: true,
        value: () => ({ values: Object.fromEntries(inputs.map((i) => [i.dataset.v, i.value])), leftover: radioValue(wrap, 'leftover') }),
      }],
    });
    if (!res) return;
    body = fillTemplate(tpl.body, res.values, res.leftover);
  }
  store.batch(`テンプレート「${tpl.name}」を反映`, (tx) => tx.update(nodeId, { body, tags: addTagsTo(n.tags, tpl.tags) }));
  toast('テンプレートを反映しました', { action: () => store.undo(), actionLabel: '元に戻す' });
}

function pickTemplate() {
  const list = store.liveTemplates();
  if (!list.length) {
    return modal({ title: 'テンプレート', body: h('p', {}, 'テンプレートがありません。メニューの「テンプレート管理」から作成できます。') }).then(() => null);
  }
  const box = h('div', { class: 'list' });
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'テンプレートを絞り込み' });
  let closeFn;
  const draw = () => {
    box.innerHTML = '';
    const q = filter.value.trim().toLowerCase();
    list.filter((t) => !q || (t.name + t.body).toLowerCase().includes(q)).forEach((t) => box.append(
      h('div', { class: 'list-item clickable', onclick: () => closeFn(t) },
        h('div', { class: 'main' }, h('div', { class: 't' }, t.name || '無題'),
          h('div', { class: 'sub' }, (t.tags.length ? `タグ：${t.tags.join('、')}　` : '') + t.body.slice(0, 40).replace(/\n/g, ' '))))));
  };
  filter.addEventListener('input', draw);
  draw();
  return modal({ title: 'テンプレートを選択', body: [filter, box], buttons: [], onOpen: (d, c) => { closeFn = c; setTimeout(() => filter.focus(), 30); } });
}

// ---------- 管理画面 ----------
export async function openTemplateManager() {
  const box = h('div', { class: 'list' });
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'テンプレートを絞り込み（名前・本文）' });
  const draw = () => {
    box.innerHTML = '';
    const q = filter.value.trim().toLowerCase();
    const list = store.liveTemplates().filter((t) => !q || (t.name + '\n' + t.body + '\n' + t.tags.join(' ')).toLowerCase().includes(q));
    if (!list.length) box.append(h('p', { class: 'muted' }, q ? '該当なし' : 'テンプレートがありません'));
    list.forEach((t) => box.append(h('div', { class: 'list-item' },
      h('div', { class: 'main' }, h('div', { class: 't' }, t.name || '無題'),
        h('div', { class: 'sub' }, `${placeholders(t.body).length ? '変数 ' + placeholders(t.body).map((v) => `{{${v}}}`).join(' ') + '　' : ''}${t.tags.length ? 'タグ：' + t.tags.join('、') : ''}`)),
      h('button', { type: 'button', class: 'btn small', onclick: async () => { await editTemplate(t.id); draw(); } }, '編集'),
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        if (!(await confirmDialog(`テンプレート「${t.name}」を削除しますか？`, { ok: '削除', danger: true }))) return;
        store.batch('テンプレート削除', (tx) => tx.updateTemplate(t.id, { deleted: true }));
        draw();
      } }, '削除'))));
  };
  filter.addEventListener('input', draw);
  draw();
  await modal({
    title: 'テンプレート管理', wide: true,
    body: [h('div', { class: 'row-inline', style: { marginBottom: '8px' } }, filter,
      h('button', { type: 'button', class: 'btn primary', onclick: async () => { await editTemplate(null); draw(); } }, '新規作成')), box],
  });
}

async function editTemplate(id) {
  const t = id ? store.templates.get(id) : { name: '', body: '', tags: [] };
  const name = h('input', { class: 'input', type: 'text', value: t.name, placeholder: '例：キャラクターシート' });
  const tags = h('input', { class: 'input', type: 'text', value: t.tags.join('、'), placeholder: '例：キャラ（「、」区切り）' });
  const body = h('textarea', {}, t.body);
  body.value = t.body;
  const res = await modal({
    title: id ? 'テンプレートを編集' : '新しいテンプレート', wide: true,
    body: [
      h('label', { class: 'field' }, h('span', {}, '名前'), name),
      h('label', { class: 'field' }, h('span', {}, '既定タグ（呼び出し時にノードへ自動付与）'), tags),
      h('label', { class: 'field' }, h('span', {}, '本文　{{変数名}} を書くと呼び出し時に入力欄が出ます'), body),
    ],
    buttons: [{ label: 'キャンセル', value: null }, { label: '保存', primary: true, value: () => true }],
  });
  if (!res) return;
  const data = { name: name.value.trim() || '無題', body: body.value, tags: addTagsTo([], tags.value.split(/[,、，]/).map(cleanTag)) };
  store.batch(id ? 'テンプレート編集' : 'テンプレート作成', (tx) => (id ? tx.updateTemplate(id, data) : tx.createTemplate(data)));
}
