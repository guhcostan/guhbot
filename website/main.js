/**
 * Waitlist form.
 *
 * Two rules shape this file:
 *
 *  1. **Never lie to the user.** If the request did not reach a server, say so
 *     and give them a way to retry, rather than showing a fake success.
 *  2. **Never depend on JavaScript to be usable.** The form is a real form with
 *     a real action; this only upgrades the experience.
 *
 * The endpoint is configurable via a `data-endpoint` attribute on the form, so a
 * deployment can point it at its own function without editing this file.
 */

const form = document.getElementById('waitlist-form');
const status = document.getElementById('waitlist-status');

/** Deliberately loose: something@something.tld, no attempt to out-clever RFC 5322. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function setStatus(state, message) {
  if (!status) return;
  status.dataset.state = state;
  status.textContent = message;
}

if (form instanceof HTMLFormElement) {
  const endpoint = form.dataset.endpoint ?? '/api/waitlist';
  const submit = form.querySelector('button[type="submit"]');
  const input = form.querySelector('input[type="email"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!(input instanceof HTMLInputElement)) return;

    const email = input.value.trim();

    if (!EMAIL.test(email)) {
      input.setAttribute('aria-invalid', 'true');
      setStatus('error', 'That does not look like an email address.');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');

    if (submit instanceof HTMLButtonElement) submit.disabled = true;
    setStatus('pending', 'Adding you…');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The page is what knows the referrer; the function stores it so we can
        // tell whether a launch actually produced signups.
        body: JSON.stringify({ email, source: 'website' }),
      });

      if (!response.ok) {
        // 409 means "already on the list", which is not a failure for the user.
        if (response.status === 409) {
          setStatus('ok', 'You are already on the list.');
          form.reset();
          return;
        }
        throw new Error(`server responded ${response.status}`);
      }

      setStatus('ok', 'You are on the list. We will email you when it is ready.');
      form.reset();
    } catch (error) {
      // Say what happened and give them an out. A silent failure here is worse
      // than no form at all, because they would assume they had signed up.
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(
        'error',
        `We could not reach the server (${detail}). Try again, or email hello@guhbot.dev and we will add you.`,
      );
    } finally {
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
    }
  });
}

// Reveal bands as they scroll in, but only when the user has not asked for
// reduced motion, and only as an enhancement: without this the page is fine.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!reduceMotion && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.animate(
          [
            { opacity: 0, transform: 'translateY(14px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
        );
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  );

  for (const band of document.querySelectorAll('.band')) {
    observer.observe(band);
  }
}
