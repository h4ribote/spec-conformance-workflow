export const meta = {
  name: 'spec-conformance-phase',
  description: 'One conformance phase: scope (parallel scouts) -> implement (sequential clusters) -> conform (parallel independent audit) -> repair. Test execution and invariant checks are NOT here — the main loop owns them after this returns.',
  phases: [
    { title: 'Scope', detail: '項目ごとに仕様原文と現行コードを読み方針を確定 (read-only)' },
    { title: 'Implement', detail: 'クラスタ別に逐次実装 (ファイル競合回避)' },
    { title: 'Conform', detail: '実装者の報告を見ずに仕様準拠を独立監査' },
    { title: 'Repair', detail: '未達項目を修正し再監査' },
  ],
}

// ---------------------------------------------------------------------------
// このスクリプトはプロジェクト非依存である。プロジェクト固有の事情は全て args 経由で渡す
// (Workflow スクリプトはファイルシステムへアクセスできないため、設定ファイルを自力で読めない)。
//
// args:
//   commonRules:  string   必須。全エージェントのプロンプト冒頭に付く共通前文。
//                          リポジトリのパス / 正典の場所と読み方 / 中核契約 / 個別テストの
//                          実行コマンド / git 操作の禁止 / コメントの自己完結ルールを含める。
//   scopeContext: string   必須。項目ごとの所見・仕様参照・コード参照がどこにあり、どう読むか。
//   items:    [{ id: string|number, hint?: string }]                    scope と audit の対象
//   clusters: [{ key: string, items: (string|number)[], hint: string }] 実装の単位 (既定で逐次)
//
//   model:            string   省略時はセッションのモデルを継承する。安価なモデルで回す時だけ指定。
//   effort:           string   省略可。'low' | 'medium' | 'high' | 'xhigh' | 'max'
//   wiringRule:       string   省略可。新規フィールドを通すべき横断経路のプロジェクト固有な記述。
//   testRule:         string   省略可。実装者に許すテスト実行の範囲。
//   auditFocus:       string   省略可。監査で特に見るべきプロジェクト固有の観点。
//   maxRepairRounds:  number   省略時 2。
//   parallelClusters: boolean  省略時 false。クラスタ間のファイル集合が完全に素な場合のみ true。
//
// Returns { scopes, implementations, conformance, repairRounds, gaps, ready_for_verification }.
// この後オーケストレーター (メインループ) が hygiene-check → フルスイート → 不変条件チェック →
// 重量テストを回してからコミットする。テスト実行をこのスクリプトへ足さないこと:
// 並列エージェントが同時にスイートを起動すると CPU 競合で打ち切られ、赤の原因が判別できなくなる。
// ---------------------------------------------------------------------------

const A = args || {}
const RULES = String(A.commonRules || '')
const SCOPE_CTX = String(A.scopeContext || '')
const ITEMS = Array.isArray(A.items) ? A.items : []
const CLUSTERS = Array.isArray(A.clusters) ? A.clusters : []
const MAX_REPAIR = Number.isFinite(A.maxRepairRounds) ? A.maxRepairRounds : 2
const PARALLEL_CLUSTERS = A.parallelClusters === true

const WIRING_RULE = String(A.wiringRule || '新規に追加したフィールド・状態・列挙値は、それが通るべき横断経路 (永続化の保存と読み戻し、スキーマ検証、移行、API 応答、型定義、クライアント側) へ漏れなく配線する。')
const TEST_RULE = String(A.testRule || '自分が触ったファイルに対応するテストだけを 1ファイルずつ smoke 実行する。フルスイートと長時間の検証は回さない (オーケストレーターが所有する)。')
const AUDIT_FOCUS = String(A.auditFocus || '')

// model / effort は指定された時だけ opts へ載せる (未指定ならセッションの既定を継承する)。
function opts(base) {
  if (A.model) base.model = String(A.model)
  if (A.effort) base.effort = String(A.effort)
  return base
}

const SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['item', 'status', 'spec_requirement', 'current_state', 'plan', 'files', 'risk', 'notes'],
  properties: {
    item: { type: 'string' },
    status: { type: 'string', enum: ['NEEDS_WORK', 'ALREADY_SATISFIED', 'PARTIALLY_SATISFIED'] },
    spec_requirement: { type: 'string', description: '仕様が要求している内容。式・列挙・順序・既定値・形状は原文どおり正確に写す。どの節かも書く。' },
    current_state: { type: 'string', description: '現在の実装。ファイル:行とシンボル名で具体的に。' },
    plan: { type: 'string', description: '実装方針。新設する関数/フィールド/エンドポイント名まで。実装者が着手できる粒度。' },
    files: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: '共通ルールに挙がった中核契約への波及リスク。' },
    notes: { type: 'string', description: '代替案と棄却理由、他項目との依存、既定値やスキーマ変更の波及、正典の内部矛盾など。' },
  },
}

const CONFORM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['item', 'status', 'summary', 'evidence', 'remaining_work'],
  properties: {
    item: { type: 'string' },
    status: { type: 'string', enum: ['DONE', 'PARTIAL', 'NOT_DONE'] },
    summary: { type: 'string' },
    evidence: { type: 'string', description: '実際に読んだ仕様の節と実装のファイル:行を具体的に。' },
    remaining_work: { type: 'string', description: 'DONE なら空文字。それ以外は仕様準拠に到達するために何をどう実装すべきかを、次の実装者が着手できる粒度で。' },
  },
}

const id = (x) => String(x)

if (ITEMS.length === 0) {
  log('items が空。scope する対象が無いので何もせず返す。')
  return { scopes: [], implementations: [], conformance: [], repairRounds: [], gaps: [], ready_for_verification: true }
}

phase('Scope')
log(`Scope: ${ITEMS.length} 項目を並列精査 (read-only)`)
const scopes = (await parallel(ITEMS.map((it) => () => agent(
  `${RULES}

## タスク: 所見「${id(it.id)}」を精査し実装方針を確定する (read-only、実装しない)

${SCOPE_CTX}

${it.hint ? '概要: ' + it.hint + '\n\n' : ''}着手前に、この所見が既に解消済みでないかをコードで最初に確認すること。仕様原文の式・列挙・順序・既定値は一字一句写し取る。共通ルールに挙がった中核契約への波及は、実コードを読んで数字で評価する。ファイルは編集しない。`,
  opts({ label: `scope:${id(it.id)}`, phase: 'Scope', agentType: 'spec-scout', schema: SCOPE_SCHEMA })
)))).filter(Boolean)

const byItem = {}
for (const s of scopes) byItem[id(s.item)] = s

function clusterBrief(mine) {
  return mine.map((m) => `### 項目 ${m.item} (risk ${m.risk}, scope 判定 ${m.status})

**仕様の要求**: ${m.spec_requirement}
**現状**: ${m.current_state}
**方針(案)**: ${m.plan}
**注意点**: ${m.notes}
**関係ファイル**: ${(m.files || []).join(', ')}`).join('\n\n')
}

function implementCluster(cl, mine) {
  return agent(
    `${RULES}

## タスク: クラスタ「${cl.key}」を仕様準拠まで実装する

担当領域: ${cl.hint}

先行の精査が各項目についてまとめた方針:

${clusterBrief(mine)}

方針は出発点であり、仕様原文が最終的な仕様である。式・列挙・順序・既定値は一字一句そのとおりに実装し、実装した機能に到達経路があることを確認する。${WIRING_RULE}

テスト: ${TEST_RULE}`,
    opts({ label: `impl:${cl.key}`, phase: 'Implement', agentType: 'spec-implementer' })
  )
}

// scope が ALREADY_SATISFIED と判定した項目は実装を回さない (誤判定は後段の独立監査が拾う)。
function pending(cl) {
  const mine = (cl.items || []).map(id).map((i) => byItem[i]).filter(Boolean)
  return mine.filter((m) => m.status !== 'ALREADY_SATISFIED')
}

phase('Implement')
const implementations = []
const runnable = CLUSTERS.map((cl) => ({ cl, mine: pending(cl) })).filter((x) => {
  if (x.mine.length === 0) { log(`cluster ${x.cl.key}: 実装不要 (スコープ結果なし、または全項目が解消済み判定)`); return false }
  return true
})

if (PARALLEL_CLUSTERS) {
  log(`Implement: ${runnable.length} クラスタを並列実装 (ファイル集合が素であることは呼び出し側の責任)`)
  const results = await parallel(runnable.map(({ cl, mine }) => () => implementCluster(cl, mine)))
  results.forEach((r, i) => {
    if (r) implementations.push({ cluster: runnable[i].cl.key, items: runnable[i].mine.map((m) => m.item), report: r })
  })
} else {
  for (const { cl, mine } of runnable) {
    log(`Implement ${cl.key}: ${mine.map((m) => m.item).join(', ')}`)
    const r = await implementCluster(cl, mine)
    if (r) implementations.push({ cluster: cl.key, items: mine.map((m) => m.item), report: r })
  }
}

function conformPrompt(itemId, extra) {
  return `${RULES}

## タスク: 所見「${itemId}」が仕様に到達したかを独立監査する (read-only)

${SCOPE_CTX}

直前に別のエージェントがこの項目を実装したと報告しているが、**その報告を一切参照せず**、仕様原文と現在のコードだけで DONE/PARTIAL/NOT_DONE を判定する。式・列挙・順序・既定値の一字一句一致、到達可能性、横断経路への配線、リポジトリだけでは辿れない参照の混入まで確認する。ファイルは編集しない。${AUDIT_FOCUS ? '\n\n特に見る観点: ' + AUDIT_FOCUS : ''}${extra || ''}`
}

phase('Conform')
log(`Conform: ${ITEMS.length} 項目を独立監査`)
const conformance = (await parallel(ITEMS.map((it) => () => agent(
  conformPrompt(id(it.id)),
  opts({ label: `conform:${id(it.id)}`, phase: 'Conform', agentType: 'spec-auditor', schema: CONFORM_SCHEMA })
)))).filter(Boolean)

let gaps = conformance.filter((c) => c.status !== 'DONE')
log(`一次監査: 未達 ${gaps.length}件 (${gaps.map((g) => g.item).join(', ') || 'なし'})`)

const repairRounds = []
let round = 0
while (gaps.length > 0 && round < MAX_REPAIR) {
  round++
  phase('Repair')
  const brief = gaps.map((g) => `### 項目 ${g.item} — ${g.status}\n${g.summary}\n**監査根拠**: ${g.evidence}\n**残作業**: ${g.remaining_work}`).join('\n\n')
  const fixed = await agent(
    `${RULES}

## タスク: 未達項目を仕様準拠まで修正する (ラウンド ${round})

独立監査で、以下が仕様に到達していないと判定された:

${brief}

仕様原文を確認して実装を完成させる。仕様を削って実装に合わせる修正は禁止 (正典の内部矛盾を示せる場合を除く)。${WIRING_RULE}

テスト: ${TEST_RULE}`,
    opts({ label: `repair:r${round}`, phase: 'Repair', agentType: 'spec-implementer' })
  )
  repairRounds.push({ round, report: fixed })

  const recheck = (await parallel(gaps.map((g) => () => agent(
    conformPrompt(g.item, `\n\n注記: 前ラウンドで「${g.status}」判定となり修正が入った。前回の判定理由: ${g.summary}`),
    opts({ label: `conform:${g.item}-r${round}`, phase: 'Repair', agentType: 'spec-auditor', schema: CONFORM_SCHEMA })
  )))).filter(Boolean)
  gaps = recheck.filter((c) => c.status !== 'DONE')
  log(`ラウンド${round}後: 未達 ${gaps.length}件`)
}

if (gaps.length > 0) log(`修正ラウンド上限 (${MAX_REPAIR}) に到達。未達 ${gaps.length}件はオーケストレーターの判断へ委ねる。`)

return {
  scopes: scopes.map((s) => ({ item: s.item, status: s.status, risk: s.risk, plan: s.plan })),
  implementations,
  conformance: conformance.map((c) => ({ item: c.item, status: c.status, summary: c.summary })),
  repairRounds,
  gaps: gaps.map((g) => ({ item: g.item, status: g.status, remaining_work: g.remaining_work })),
  ready_for_verification: gaps.length === 0,
}
