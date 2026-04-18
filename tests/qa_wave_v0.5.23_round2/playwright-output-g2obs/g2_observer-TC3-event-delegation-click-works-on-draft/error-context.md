# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: g2_observer.spec.ts >> TC3: event delegation click works on draft
- Location: g2_observer.spec.ts:163:5

# Error details

```
TimeoutError: locator.getAttribute: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#tbl-available button[data-draft]:not([disabled])').first()

```

# Test source

```ts
  141 |   const sQuery = await (await request.get(`${BASE}/api/league/settings?league_id=${freshId}`)).json();
  142 |   log('tc2_settings_via_query', { league_name: sQuery.league_name });
  143 | 
  144 |   // Switch via UI: just POST then reload page -- check header text
  145 |   await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: freshId } });
  146 |   await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  147 |   const headerName = await page.evaluate(() => {
  148 |     const n = document.querySelector('[data-league-name], .league-name, #league-name, header .name');
  149 |     return n ? (n as HTMLElement).textContent?.trim() : null;
  150 |   });
  151 |   const allHeaderText = await page.locator('header').first().innerText().catch(() => '');
  152 |   log('tc2_header_text', { headerName, allHeaderText: allHeaderText.slice(0, 500), freshId });
  153 | 
  154 |   // Clean up: delete if endpoint exists (soft, ignore failure)
  155 |   try {
  156 |     await request.post(`${BASE}/api/leagues/delete`, { data: { league_id: freshId } });
  157 |   } catch (e) {}
  158 | });
  159 | 
  160 | // ----------------------------------------------------------------------------
  161 | // TC3: Draft page — delegation fires on first human-turn click
  162 | // ----------------------------------------------------------------------------
  163 | test('TC3: event delegation click works on draft', async ({ page, request }) => {
  164 |   attachHooks(page, 'tc3');
  165 | 
  166 |   // Ensure active = observer league and it has a draft state
  167 |   await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });
  168 |   // Force start / reset draft (idempotent -- if setup not complete, setup default)
  169 |   // Try common setup endpoints
  170 |   const setupRes = await request.post(`${BASE}/api/league/setup`, {
  171 |     data: {
  172 |       league_id: OBS_LEAGUE,
  173 |       league_name: OBS_LEAGUE,
  174 |       season_year: '2025-26',
  175 |       num_teams: 8,
  176 |       roster_size: 13,
  177 |       starters_per_day: 10,
  178 |       il_slots: 3,
  179 |       player_team_index: 0,
  180 |       team_names: ['我的隊伍', 'BPA', 'PuntTO', 'S&S', 'Balanced', 'Youth', 'VetWin', 'Contrarian'],
  181 |       randomize_draft_order: false,
  182 |       scoring_weights: { pts: 1, reb: 1.2, ast: 1.5, stl: 2.5, blk: 2.5, to: -1 },
  183 |       regular_season_weeks: 20,
  184 |       playoff_teams: 6,
  185 |       ai_trade_frequency: 'normal',
  186 |       ai_trade_style: 'balanced',
  187 |     },
  188 |   });
  189 |   log('tc3_setup_resp', { status: setupRes.status(), body: (await setupRes.text()).slice(0, 300) });
  190 | 
  191 |   // Reset draft to a clean slate (draft auto-starts after setup)
  192 |   const resetRes = await request.post(`${BASE}/api/draft/reset`, { data: {} });
  193 |   log('tc3_draft_reset', { status: resetRes.status(), body: (await resetRes.text()).slice(0, 300) });
  194 | 
  195 |   // Navigate to draft page
  196 |   await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  197 |   await page.waitForTimeout(1500);
  198 | 
  199 |   // Advance AIs until human-turn
  200 |   for (let i = 0; i < 20; i++) {
  201 |     const st = await (await request.get(`${BASE}/api/state`)).json();
  202 |     log('tc3_poll_state', {
  203 |       iter: i,
  204 |       current_team_id: st.current_team_id,
  205 |       human_team_id: st.human_team_id,
  206 |       is_complete: st.is_complete,
  207 |       current_overall: st.current_overall,
  208 |     });
  209 |     if (st.is_complete) break;
  210 |     if (st.current_team_id === st.human_team_id) break;
  211 |     const adv = await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
  212 |     log('tc3_ai_adv', { iter: i, status: adv.status() });
  213 |     await page.waitForTimeout(150);
  214 |   }
  215 | 
  216 |   // Reload draft page at human turn
  217 |   await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  218 |   await page.waitForTimeout(2000);
  219 | 
  220 |   // Check delegation marker
  221 |   const delegationProbe = await page.evaluate(() => {
  222 |     const tbl = document.querySelector('#tbl-available') as HTMLElement | null;
  223 |     if (!tbl) return { tblFound: false };
  224 |     return {
  225 |       tblFound: true,
  226 |       delegated: tbl.dataset.draftDelegated,
  227 |       buttonCount: tbl.querySelectorAll('button[data-draft]').length,
  228 |       disabledButtons: tbl.querySelectorAll('button[data-draft][disabled]').length,
  229 |     };
  230 |   });
  231 |   log('tc3_delegation_marker', delegationProbe);
  232 | 
  233 |   await page.screenshot({ path: path.join(SHOT_DIR, 'tc3_draft_human_turn.png'), fullPage: true });
  234 | 
  235 |   // Attempt first click via locator
  236 |   const firstBtn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
  237 |   const countAvail = await page.locator('#tbl-available button[data-draft]').count();
  238 |   log('tc3_button_count', { totalAvail: countAvail });
  239 | 
  240 |   if (countAvail > 0) {
> 241 |     const pidBefore = await firstBtn.getAttribute('data-draft');
      |                                      ^ TimeoutError: locator.getAttribute: Timeout 30000ms exceeded.
  242 |     log('tc3_about_to_click', { pidBefore });
  243 | 
  244 |     // capture pre-click state.current_overall
  245 |     const stBefore = await (await request.get(`${BASE}/api/state`)).json();
  246 |     log('tc3_state_before_click', {
  247 |       current_overall: stBefore.current_overall,
  248 |       current_team_id: stBefore.current_team_id,
  249 |       human_team_id: stBefore.human_team_id,
  250 |     });
  251 | 
  252 |     await firstBtn.click({ timeout: 5000 });
  253 |     await page.waitForTimeout(1500);
  254 | 
  255 |     const stAfter = await (await request.get(`${BASE}/api/state`)).json();
  256 |     log('tc3_state_after_click', {
  257 |       current_overall: stAfter.current_overall,
  258 |       current_team_id: stAfter.current_team_id,
  259 |       last_pick: stAfter.recent_picks?.slice(-1)?.[0],
  260 |     });
  261 |     const clickRegistered = stAfter.current_overall > stBefore.current_overall;
  262 |     log('tc3_click_registered', { registered: clickRegistered });
  263 |   } else {
  264 |     log('tc3_no_buttons', {});
  265 |   }
  266 | });
  267 | 
  268 | // ----------------------------------------------------------------------------
  269 | // TC4: Delegation survives AI rounds -- click again on next human turn
  270 | // ----------------------------------------------------------------------------
  271 | test('TC4: delegation still fires after 7 AI turns', async ({ page, request }) => {
  272 |   attachHooks(page, 'tc4');
  273 |   await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });
  274 |   await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  275 |   await page.waitForTimeout(1000);
  276 | 
  277 |   // Advance via server API until human turn again
  278 |   for (let i = 0; i < 20; i++) {
  279 |     const st = await (await request.get(`${BASE}/api/state`)).json();
  280 |     if (st.is_complete) break;
  281 |     if (st.current_team_id === st.human_team_id) break;
  282 |     await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
  283 |     await page.waitForTimeout(120);
  284 |   }
  285 |   await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  286 |   await page.waitForTimeout(1500);
  287 | 
  288 |   const delegationProbe2 = await page.evaluate(() => {
  289 |     const tbl = document.querySelector('#tbl-available') as HTMLElement | null;
  290 |     if (!tbl) return { tblFound: false };
  291 |     // Also check: only one listener attached (delegated marker is '1')?
  292 |     return {
  293 |       tblFound: true,
  294 |       delegated: tbl.dataset.draftDelegated,
  295 |       btnCount: tbl.querySelectorAll('button[data-draft]').length,
  296 |     };
  297 |   });
  298 |   log('tc4_delegation_marker_after_ai_turns', delegationProbe2);
  299 | 
  300 |   const btn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
  301 |   const count = await page.locator('#tbl-available button[data-draft]').count();
  302 |   if (count > 0) {
  303 |     const stBefore = await (await request.get(`${BASE}/api/state`)).json();
  304 |     await btn.click({ timeout: 5000 });
  305 |     await page.waitForTimeout(1500);
  306 |     const stAfter = await (await request.get(`${BASE}/api/state`)).json();
  307 |     log('tc4_after_click', {
  308 |       before: stBefore.current_overall,
  309 |       after: stAfter.current_overall,
  310 |       registered: stAfter.current_overall > stBefore.current_overall,
  311 |     });
  312 |   }
  313 | });
  314 | 
  315 | // ----------------------------------------------------------------------------
  316 | // TC5: Force re-render via display-mode select, click immediately
  317 | // ----------------------------------------------------------------------------
  318 | test('TC5: delegation survives display-mode re-render', async ({ page, request }) => {
  319 |   attachHooks(page, 'tc5');
  320 |   await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });
  321 | 
  322 |   // Need human turn again
  323 |   for (let i = 0; i < 20; i++) {
  324 |     const st = await (await request.get(`${BASE}/api/state`)).json();
  325 |     if (st.is_complete) break;
  326 |     if (st.current_team_id === st.human_team_id) break;
  327 |     await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
  328 |     await page.waitForTimeout(120);
  329 |   }
  330 |   await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  331 |   await page.waitForTimeout(1500);
  332 | 
  333 |   // Find display-mode select (there is a select with prev_full / current_full options)
  334 |   const selectExists = await page.locator('select').filter({ hasText: '上季' }).count();
  335 |   log('tc5_select_count', { selectExists });
  336 | 
  337 |   // Try toggling any select that has prev_full option
  338 |   const toggled = await page.evaluate(() => {
  339 |     const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
  340 |     const target = selects.find((s) => Array.from(s.options).some((o) => o.value === 'prev_full'));
  341 |     if (!target) return { switched: false };
```