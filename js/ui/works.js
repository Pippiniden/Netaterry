// 作品の一覧・切り替え・作成・名前変更・複製・削除・ファイルへの保存
import { store } from '../store.js';
import { downloadText, stamp } from '../util.js';
import { h, $, modal, confirmDialog, promptDialog, toast, iconBtn } from './dom.js';
import { importDataFile } from './io.js';
import { auth } from '../drive.js';

const safeName = (s) => (s || '無題の作品').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60);

/** 上部の作品名ボタン */
export function renderWorkTitle() {
  const w = store.work;
  const name = w ? w.name : '';
  const b = $('#btn-work');
  if (b) b.querySelector('.name').textContent = name;
  document.title = name ? `${name} - Netaterry` : 'Netaterry';
}

/** 作品をファイルに保存（ドライブの作品ファイルと同じ形式） */
export async function saveWorkToFile(workId = store.workId) {
  if (workId === store.workId) await store.flush();
  const data = await store.loadWorkData(workId);
  downloadText(`${safeName(data.work.name)}-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast('作品をファイルに保存しました');
}

export async function newWork() {
  const name = await promptDialog('作品名', '', { title: '新しい作品', ok: '作成', placeholder: '例：オデュッセイア' });
  if (name == null) return false;
  await store.createWork(name.trim() || '新しい作品');
  toast(`作品「${store.work.name}」を作りました`);
  return true;
}

export async function openWorks() {
  const box = h('div', { class: 'works' });
  let closeFn = null;
  const draw = () => {
    box.innerHTML = '';
    const list = h('div', { class: 'list' });
    for (const w of store.liveWorks()) {
      const cur = w.id === store.workId;
      const notes = [];
      if (w.needsDownload) notes.push(auth.hasToken ? 'ドライブから読み込み待ち' : 'ドライブにあります（ログインすると読み込みます）');
      else if (w.sync.fileId) notes.push(w.sync.dirty ? '未同期の変更あり' : 'ドライブと同期');
      else notes.push(w.sync.dirty && store.meta.everSynced ? 'まだドライブにありません' : 'この端末のみ');
      const row = h('div', { class: 'list-item work-item' + (cur ? ' current' : ''), dataset: { id: w.id } },
        h('button', { type: 'button', class: 'main work-open', 'aria-current': cur ? 'true' : null, onclick: async () => {
          if (!cur) { await store.switchWork(w.id); toast(`「${w.name}」を開きました`); }
          closeFn && closeFn(null);
        } },
          h('div', { class: 't' }, w.name, cur ? h('span', { class: 'chip small on' }, '開いています') : null),
          h('div', { class: 'sub' }, notes.join('・'))),
        iconBtn('more', `「${w.name}」の操作`, (e) => { e.stopPropagation(); workActions(w.id, draw); }));
      list.append(row);
    }
    box.append(list,
      h('p', { class: 'muted' }, 'テンプレートと設定は全作品で共通です。ノード・タグ・共通メモは作品ごとに分かれます。'));
  };
  draw();
  const off = () => draw();
  store.on('works', off);
  store.on('work', off);
  const act = await modal({
    title: '作品', wide: true, body: box,
    buttons: [{ label: 'ファイルから読み込む', value: 'import' }, { label: '新しい作品', value: 'new', primary: true }],
    onOpen: (dlg, c) => { closeFn = c; setTimeout(() => dlg.querySelector('.work-item.current .work-open')?.focus(), 30); },
  });
  store.off('works', off);
  store.off('work', off);
  if (act === 'new') await newWork();
  else if (act === 'import') await importDataFile();
}

async function workActions(workId, redraw) {
  const w = store.works.get(workId);
  if (!w) return;
  const act = await modal({
    title: `作品「${w.name}」`,
    body: h('p', { class: 'muted' }, '操作を選んでください。'),
    buttons: [
      { label: '名前を変更', value: 'rename' },
      { label: '複製', value: 'dup' },
      { label: 'ファイルに保存', value: 'save' },
      { label: '削除', value: 'delete', danger: true },
    ],
  });
  if (act === 'rename') {
    const name = await promptDialog('新しい作品名', w.name, { title: '作品名の変更', ok: '変更' });
    if (name && name.trim()) { await store.renameWork(workId, name); toast('作品名を変更しました'); }
  } else if (act === 'dup') {
    const name = await promptDialog('複製した作品の名前', `${w.name}のコピー`, { title: '作品の複製', ok: '複製' });
    if (name != null) {
      if (w.needsDownload) { toast('まだドライブから読み込んでいない作品は複製できません'); return; }
      await store.duplicateWork(workId, name.trim() || `${w.name}のコピー`);
      toast(`「${store.work.name}」を作りました`);
    }
  } else if (act === 'save') {
    if (w.needsDownload) { toast('まだドライブから読み込んでいない作品です'); return; }
    await saveWorkToFile(workId);
  } else if (act === 'delete') {
    const onDrive = !!w.sync.fileId;
    const ok = await confirmDialog(
      `作品「${w.name}」を削除します。\nこの作品のノード・共通メモはこの端末から消えます。` +
      (onDrive ? '\nGoogleドライブのファイルは次の同期でドライブのゴミ箱へ移ります（30日間は戻せます）。他の端末からも消えます。' : '\n元に戻せません。必要なら先に「ファイルに保存」してください。'),
      { ok: '削除', danger: true, title: '作品の削除' });
    if (!ok) return;
    await store.deleteWork(workId);
    toast(`作品「${w.name}」を削除しました`);
  }
  redraw();
}
