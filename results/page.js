// Renders data.json (written by build.mjs at deploy time). No network beyond that file, no frameworks.
const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US'));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const hours = (h) => (h == null ? '—' : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`);
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const link = (href, text) => {
  const a = el('a', text);
  a.href = href;
  return a;
};

function card(label, value, caption) {
  const c = el('div', null, 'card');
  c.append(el('div', label, 'label'), el('div', value, 'big'), el('div', caption, 'muted'));
  return c;
}

async function main() {
  const d = await (await fetch('data.json', { cache: 'no-store' })).json();
  const t = d.totals;
  const c = d.cost;
  const repo = `https://github.com/${d.source}`;
  const cards = document.getElementById('cards');
  cards.replaceChildren(
    card('Languages shipped', `${t.finished} / ${t.languages}`, `${n(t.tasks_done)} factory tasks done${t.core_tasks_done ? ` (${n(t.core_tasks_done)} of them shared core)` : ''}`),
    card('Hands-off', pct(t.hands_off, t.hands_off_known), `${n(t.hands_off)} of ${n(t.hands_off_known)} agent PRs merged with no person's commit, comment or review`),
    card('Reverts', n(t.reverts), `merged changes undone afterwards${t.drill_reverts ? ` (plus ${t.drill_reverts} in drills)` : ''}`),
    card('Total cost', `${n(c.total_aic)} AIC`, `build ${n(c.build_aic)} (to ${c.build_as_of}) + agent runs ${n(c.runs_aic)} (v1 ${n(c.v1_aic)} over ${n(c.v1_runs)} runs${c.v1_bounded_runs ? `, of which ${n(c.v1_bounded_runs)} with incomplete usage at the ${n(c.v1_bounded_aic)} they recorded (caps ${n(c.v1_bounded_cap_aic)})` : ''}${c.v1_unknown ? `, ${c.v1_unknown} unknown` : ''}; v2 ${n(c.v2_aic)} over ${n(c.v2_runs)}${c.v2_unknown ? `, ${c.v2_unknown} unknown` : ''})`),
    card('Drills passed', `${d.drills.fire_drills_passed} / ${d.drills.fire_drills}`, `fire drills (to ${d.drills.as_of}); agentic canary ${d.drills.canary_passed} / ${d.drills.canary_runs} live checks${d.drills.canary_dry ? ` (${d.drills.canary_dry} dry runs aside)` : ''}${d.drills.canary_unknown ? `, ${d.drills.canary_unknown} unknown` : ''}`),
  );
  const body = document.querySelector('#langs tbody');
  body.replaceChildren(...d.rows.map((r) => {
    const tr = el('tr');
    const work = r.tasks ? `${r.tasks_done} / ${r.tasks - r.tasks_cancelled} tasks${r.tasks_cancelled ? ` (${r.tasks_cancelled} cancelled)` : ''}` : `${r.prs} PR${r.prs === 1 ? '' : 's'}`;
    const unknown = r.agent_prs - r.hands_off_known;
    const hands = r.hands_off_known ? `${r.hands_off} / ${r.hands_off_known}${unknown ? ` (+${unknown} unknown)` : ''}` : r.agent_prs ? `${unknown} unknown` : '—';
    tr.append(el('th', r.code), el('td', r.method), el('td', n(r.steps), 'num'), el('td', work, 'num'), el('td', hands, 'num'), el('td', hours(r.hours), 'num'), el('td', r.finished ? 'yes' : 'in progress'));
    tr.firstChild.scope = 'row';
    return tr;
  }));
  const ul = document.querySelector('#reverts ul');
  ul.replaceChildren(...(d.reverts.length ? d.reverts.map((r) => {
    const li = el('li');
    li.append(link(`${repo}/pull/${r.number}`, `#${r.number}`), ` ${r.title} (${r.merged_at.slice(0, 10)}${r.drill ? ', a drill' : ''})`);
    return li;
  }) : [el('li', 'none')]));
  document.getElementById('cao').href = d.cao;
  const f = document.getElementById('footer');
  f.replaceChildren(`Generated ${d.generated_at.replace('T', ' ').slice(0, 16)} UTC from `, link(repo, d.source), ' (task issues, merged PRs, the audit log, run usage). Costs are AI credits (AIC).');
}

main().catch((e) => {
  document.getElementById('cards').replaceChildren(el('p', `Couldn't load the results: ${e.message}`));
});
