/* Scripted product examples. They never call a model or touch visitor files. */
const examples = {
  research: {
    name: 'Research',
    avatar: 'guh',
    description: 'Finds the signal in your notes.',
    prompt: 'Find the key ideas in my notes.',
    answer: 'Three themes stood out. Here is the short version.',
    file: 'summary.md',
    detail: 'Key themes and your next steps',
    summary:
      '1. Keep the first version focused.\n2. Make the next action obvious.\n3. Validate with the people who will use it.',
    title: 'From a pile of notes\nto a clear next step.',
    body: 'Give your bot a question and a workspace. It reads, organizes, and helps you turn the information into something useful.',
    artTitle: 'A little clarity',
    note: 'The important parts.\nAll in one place.',
    line: 'Ready for your next step',
  },
  development: {
    name: 'Developer',
    avatar: 'peach',
    description: 'A second pair of eyes on your project.',
    prompt: 'Review the changes in my project.',
    answer:
      'I found two edge cases worth checking. Here is a review you can work through.',
    file: 'review.md',
    detail: 'Findings, context, and suggested checks',
    summary:
      '1. Handle an empty response before rendering.\n2. Keep a failed request easy to retry.\n3. Run the project checks after the fix.',
    title: 'Another pair of eyes.\nA clearer way forward.',
    body: 'Ask for a review, explore an idea, or break a change into smaller steps. Your bot works with the project on your own host.',
    artTitle: 'A thoughtful review',
    note: 'A fresh perspective.\nA better next version.',
    line: 'Reviewed, with a next step',
  },
  everyday: {
    name: 'Assistant',
    avatar: 'mint',
    description: 'Makes a little room in your day.',
    prompt: 'Help me turn these notes into a plan.',
    answer: 'Here is a manageable plan, with the most important thing first.',
    file: 'today.md',
    detail: 'A short plan you can actually use',
    summary:
      '1. Finish the task that unblocks the rest.\n2. Leave time to review what you made.\n3. Move the remaining ideas into tomorrow.',
    title: 'Less loose ends.\nMore room to think.',
    body: 'Turn a rough thought into a plan, organize your notes, or draft something you need. Start with one useful task.',
    artTitle: 'One thing at a time',
    note: 'A little less busy.\nA little more focus.',
    line: 'Your day, a little lighter',
  },
};
let selected = 'research';
const content = document.querySelector('.document-content');
const open = document.querySelector('.document-open');
function setExample(key) {
  const example = examples[key];
  if (!example) return;
  selected = key;
  for (const button of document.querySelectorAll('[data-job]')) {
    const active = button.dataset.job === key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const values = {
    '.demo-name': example.name,
    '.demo-description': example.description,
    '.demo-user': example.prompt,
    '.demo-answer': example.answer,
    '.demo-file': example.file,
    '.demo-file-detail': example.detail,
    '.demo-placeholder': `Give ${example.name} something to do…`,
    '#workflow-description': example.body,
    '#workflow-art-title': example.artTitle,
    '#workflow-note-line': example.line,
  };
  for (const [selector, text] of Object.entries(values))
    for (const element of document.querySelectorAll(selector))
      element.textContent = text;
  for (const [selector, text] of [
    ['#workflow-title', example.title],
    ['#workflow-note-title', example.note],
  ]) {
    const element = document.querySelector(selector);
    if (element) {
      element.textContent = text;
      element.style.whiteSpace = 'pre-line';
    }
  }
  for (const avatar of document.querySelectorAll('.demo-avatar'))
    avatar.setAttribute('src', `./assets/brand/${example.avatar}.svg`);
  if (content) {
    content.hidden = true;
    content.textContent = example.summary;
    content.style.whiteSpace = 'pre-line';
  }
  if (open) open.setAttribute('aria-expanded', 'false');
}
for (const button of document.querySelectorAll('[data-job]'))
  button.addEventListener('click', () => setExample(button.dataset.job));
open?.addEventListener('click', () => {
  if (!content) return;
  content.textContent = examples[selected].summary;
  content.style.whiteSpace = 'pre-line';
  content.hidden = !content.hidden;
  open.setAttribute('aria-expanded', String(!content.hidden));
});
const hero = document.querySelector('.hero');
const eyes = document.querySelector('.mascot-eyes');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let frame = 0;
hero?.addEventListener('pointermove', (event) => {
  if (reduced.matches || event.pointerType === 'touch') return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const bounds = hero.getBoundingClientRect();
    const x = Math.max(
      -7,
      Math.min(7, (event.clientX - bounds.left - bounds.width / 2) / 70),
    );
    const y = Math.max(
      -6,
      Math.min(6, (event.clientY - bounds.top - bounds.height / 2) / 40),
    );
    eyes?.style.setProperty('--eye-x', `${x}px`);
    eyes?.style.setProperty('--eye-y', `${y}px`);
  });
});
hero?.addEventListener('pointerleave', () => {
  cancelAnimationFrame(frame);
  eyes?.style.setProperty('--eye-x', '0px');
  eyes?.style.setProperty('--eye-y', '0px');
});
if (!reduced.matches) {
  document.querySelector('.hero-copy')?.animate(
    [
      { opacity: 0, transform: 'translateY(12px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 650, easing: 'cubic-bezier(.2,.7,.2,1)' },
  );
  document.querySelector('.hero-mascot')?.animate(
    [
      { opacity: 0, transform: 'rotate(-16deg) scale(.92)' },
      { opacity: 1, transform: 'rotate(0deg) scale(1)' },
    ],
    { duration: 850, easing: 'cubic-bezier(.2,.7,.2,1)' },
  );
}
