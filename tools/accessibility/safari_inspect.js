(() => {
  const visible = e => !!e && !!e.getClientRects().length && !e.closest('[aria-hidden="true"], [hidden]') && getComputedStyle(e).visibility !== 'hidden';
  const label = e => {
    if (!e) return '';
    const ids = (e.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    const byId = ids.map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    const labels = e.labels ? Array.from(e.labels).map(x => x.textContent).join(' ') : '';
    return (byId || e.getAttribute('aria-label') || labels || ((e.matches('button,a,[role="button"]')) ? e.textContent : '') || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  };
  const role = e => {
    if (!e) return '';
    if (e.getAttribute('role')) return e.getAttribute('role');
    if (e.matches('textarea,input:not([type]),input[type="text"]')) return 'textbox';
    if (e.matches('input[type="file"]')) return 'file';
    if (e.matches('select')) return 'combobox';
    if (e.matches('button')) return 'button';
    if (e.matches('a[href]')) return 'link';
    return e.tagName.toLowerCase();
  };
  const tests = [
    ['제목', '#book-title', 'textbox', '제목'],
    ['원고', '#manuscript', 'textbox', '원고'],
    ['예시 원고', 'button', 'button', '예시 원고 넣기'],
    ['변환 파일', '#batch-files', 'file', '오디오 파일 선택'],
    ['변환 형식', '#batch-format', 'combobox', '결과 형식'],
    ['품질 파일', '#quality-panel input[type="file"]', 'file', '기존 오디오 파일 선택'],
    ['변환 이동 링크', 'a[href="#batch-converter"]', 'link', '여러 파일 형식']
  ];
  const checks = tests.map(([id, selector, expectedRole, expectedName]) => {
    let e = id === '예시 원고' ? Array.from(document.querySelectorAll(selector)).find(b => label(b).includes(expectedName)) : document.querySelector(selector);
    let actualRole = role(e), actualName = label(e);
    return {id, status: visible(e) && actualRole === expectedRole && actualName.includes(expectedName) ? 'PASS' : 'FAIL', role: actualRole, name: actualName, visible: visible(e)};
  });
  let e = document.activeElement;
  return JSON.stringify({checks, focused: {tag: e?.tagName || '', role: role(e), name: label(e)}, hash: location.hash, ready: document.readyState});
})()
