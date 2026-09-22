const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('../apps/desktop/node_modules/typescript')
const source = fs.readFileSync('apps/desktop/src/renderer/src/App.tsx', 'utf8')
const start = source.indexOf('<div className="row">', source.indexOf('<div className="main-head">'))
const header = source.slice(start, source.indexOf('<div className="tabs">', start))
const handler = source.slice(source.indexOf('  async function startGlobalCoordinator('), source.indexOf('  async function removeGlobalTask('))
const jsx = (type, props, ...children) => ({type, props, children})
function run(code, context) {
  return vm.runInNewContext(ts.transpileModule(code, {compilerOptions:{jsx:ts.JsxEmit.React, target:ts.ScriptTarget.ES2022}}).outputText, context)
}
function buttons(node) {
  if (!node || typeof node !== 'object') return []
  return [...(node.type === 'button' ? [node] : []), ...node.children.flatMap(buttons)]
}
const label = node => node.children.filter(x => typeof x === 'string').join('').trim()
for (const tab of ['board', 'terminals', 'info']) {
  for (const openGlobal of [undefined, {id:'g1'}]) {
    const actions = []
    const tree = run(`const tree = (${header}); tree`, {
      React:{createElement:jsx}, Icon:{terminal:'icon',users:'icon',plus:'icon'}, active:{id:'p1'}, tab, openGlobal,
      openShell(){}, setShowCoord:v=>actions.push(['coordinator',v]), setShowNew:v=>actions.push(['subtask',v]), setGlobalModal:v=>actions.push(['global',v.mode])
    })
    const bs = buttons(tree)
    assert.equal(bs.some(b=>label(b)==='Координатор'), !openGlobal)
    const create = bs.find(b=>label(b).startsWith('Новая'))
    create.props.onClick()
    console.log(JSON.stringify({tab,global:openGlobal?.id ?? null,button:label(create),action:actions[0]}))
    if (openGlobal && tab !== 'board') assert.equal(actions[0][0], 'global', 'Regression reproduction changed')
    else assert.equal(actions[0][0], openGlobal ? 'subtask' : 'global')
  }
}
;(async () => {
  for (const scenario of ['inbox','live','start','cancel']) {
    const calls = []
    const ctx = {active:{id:'p1'},coordinatorPtys:new Map(scenario==='live'?[['g1','pty-live']]:[]),
      showTerminal:(...args)=>calls.push(['show',...args]),confirm:()=>{calls.push(['confirm']);return scenario!=='cancel'},
      window:{orca:{globalTasks:{startCoordinator:async(...args)=>{calls.push(['start',...args]);return 'pty-new'}}}},alert:()=>assert.fail('Unexpected alert'),ipcErrorMessage:String}
    const fn = run(`${handler}\nstartGlobalCoordinator`,ctx)
    await fn({id:'g1',title:'Task',inbox:scenario==='inbox',progress:{total:2}})
    const expected = {inbox:[],live:[['show','pty-live','p1']],start:[['confirm'],['start','g1',120,30],['show','pty-new','p1']],cancel:[['confirm']]}
    assert.deepEqual(calls,expected[scenario])
    console.log(`${scenario}: PASS`)
  }
})().catch(e=>{console.error(e);process.exitCode=1})
