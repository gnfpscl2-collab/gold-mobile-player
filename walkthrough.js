const dialog = document.getElementById('walkthrough');
const content = document.getElementById('guide-content');
const toc = document.getElementById('guide-toc');
const jump = document.getElementById('guide-jump');
const area = document.getElementById('guide-area');
const status = document.getElementById('guide-status');
const retry = document.getElementById('guide-retry');
const desktop = matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)');

let sections = [];
let loading = false;

function appendText(parent, tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
  return element;
}

function parseGuide(text) {
  const introduction = { title: '읽는 순서', lines: [] };
  const chapters = [introduction];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('## ')) chapters.push({ title: line.slice(3), lines: [] });
    else if (line && !line.startsWith('# ')) chapters.at(-1).lines.push(line);
  }
  return chapters.filter(chapter => chapter.lines.length);
}

function renderBody(container, lines) {
  let list;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (!list) {
        list = document.createElement('ul');
        container.append(list);
      }
      appendText(list, 'li', line.slice(2));
      continue;
    }
    list = undefined;
    if (line.startsWith('[') && line.endsWith(']')) appendText(container, 'h3', line.slice(1, -1));
    else appendText(container, 'p', line);
  }
}

function jumpTo(index, moveFocus = true) {
  const section = sections[index];
  if (!section) return;
  area.value = String(index);
  section.open = true;
  section.scrollIntoView({ block: 'start' });
  if (moveFocus) section.querySelector('summary').focus({ preventScroll: true });
}

function applyLayout() {
  for (const [index, section] of sections.entries()) {
    section.open = desktop.matches || index === Number(area.value);
  }
}

function renderGuide(chapters) {
  const options = document.createDocumentFragment();
  const links = document.createDocumentFragment();
  const body = document.createDocumentFragment();
  sections = chapters.map(({ title, lines }, index) => {
    const id = 'guide-chapter-' + (index + 1);
    const option = appendText(options, 'option', title);
    option.value = String(index);
    const link = appendText(links, 'a', title);
    link.href = '#' + id;
    link.addEventListener('click', event => { event.preventDefault(); jumpTo(index); });
    const section = document.createElement('details');
    section.className = 'guide-chapter';
    section.id = id;
    const summary = appendText(section, 'summary', title);
    summary.addEventListener('click', () => {
      if (desktop.matches || section.open) return;
      area.value = String(index);
      for (const other of sections) if (other !== section) other.open = false;
    });
    const chapterBody = document.createElement('div');
    chapterBody.className = 'guide-chapter-body';
    renderBody(chapterBody, lines);
    section.append(chapterBody);
    body.append(section);
    return section;
  });
  area.replaceChildren(options);
  toc.replaceChildren(links);
  content.replaceChildren(body);
  applyLayout();
  jump.hidden = false;
  toc.hidden = false;
}

async function loadGuide() {
  if (loading || sections.length) return;
  loading = true;
  status.textContent = '공략집을 불러오는 중…';
  status.hidden = false;
  retry.hidden = true;
  try {
    const response = await fetch('./walkthrough-ko.txt');
    if (!response.ok) throw new Error('Guide unavailable');
    const chapters = parseGuide(await response.text());
    if (chapters.length < 2) throw new Error('Guide is incomplete');
    renderGuide(chapters);
    status.hidden = true;
  } catch {
    status.textContent = '공략집을 열지 못했습니다. 연결을 확인한 뒤 다시 불러오세요.';
    retry.hidden = false;
  } finally {
    loading = false;
  }
}

document.getElementById('open-walkthrough').addEventListener('click', () => {
  dialog.showModal();
  loadGuide();
});
retry.addEventListener('click', loadGuide);
area.addEventListener('change', () => {
  applyLayout();
  jumpTo(Number(area.value), false);
});
desktop.addEventListener('change', applyLayout);
