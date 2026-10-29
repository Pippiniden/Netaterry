// 同期の競合ダイアログ（両方の端末が変更した項目について、どちらを残すか尋ねる）
import { h, modal, checkbox } from './dom.js';
import { formatDate } from '../util.js';

const KIND_LABEL = { node: 'ノード', template: 'テンプレート', global: '共通メモ' };

function versionOf(c, side) {
  const x = c[side];
  const gone = x.purged ? '（完全に削除）' : x.deleted ? '（削除済み）' : '';
  const title = c.kind === 'node' ? x.title : c.kind === 'template' ? x.name : '';
  const text = c.kind === 'global' ? x.text : x.body;
  const parts = [];
  if (title || c.kind !== 'global') parts.push(h('div', { class: 'cf-title' }, (title || '無題') + gone));
  if (c.kind === 'node' && x.sideNote) parts.push(h('div', { class: 'cf-sub muted' }, 'サイドメモあり'));
  parts.push(h('pre', { class: 'cf-body' }, text || (gone ? '' : '（空）')));
  return parts;
}

/** sync.onConflict に登録する関数 */
export async function askConflict(c, { index, total, name, canBoth }) {
  const newerRemote = c.remote.updatedAt > c.local.updatedAt;
  const all = { v: false };
  const col = (side, label, badge) => h('section', { class: 'cf-col' },
    h('div', { class: 'cf-head' }, h('strong', {}, label), badge ? h('span', { class: 'cf-badge' }, '新しい') : null),
    h('div', { class: 'cf-time muted' }, `更新：${formatDate(c[side].updatedAt)}`),
    ...versionOf(c, side));
  const body = [
    h('p', { class: 'pre' }, `${name ? name + ' の' : ''}${KIND_LABEL[c.kind]}が、前回の同期のあと、この端末とGoogleドライブ（他の端末）の両方で変更されています。どちらを残しますか？`),
    h('div', { class: 'cf-cols' }, col('local', 'この端末', !newerRemote), col('remote', 'ドライブ（他の端末）', newerRemote)),
    total > 1 ? checkbox(`このあとの競合（残り${total - index}件）も、今回は同じ選択にして聞かない`, false, (v) => { all.v = v; }) : null,
    h('p', { class: 'muted cf-note' }, '選ばなかった方の内容は上書きされます。「両方残す」を選ぶと、ドライブ側の内容を別のノードとして残します。'),
  ];
  const pick = (choice) => () => ({ choice, all: all.v });
  const buttons = [{ label: 'あとで（同期を中断）', value: null }];
  if (canBoth) buttons.push({ label: '両方残す', value: pick('both') });
  buttons.push({ label: 'ドライブの内容にする', value: pick('remote'), primary: newerRemote });
  buttons.push({ label: 'この端末の内容にする', value: pick('local'), primary: !newerRemote });
  return modal({ title: `同期の競合${total > 1 ? `（${index}/${total}）` : ''}`, wide: true, body, buttons });
}
