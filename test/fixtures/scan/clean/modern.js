// Modern code: no marker in the rule table matches these lines.
const dialog = document.querySelector('dialog')

export function openDialog() {
  dialog?.showModal()
}

/** Component theming travels through inherited custom properties, not a context pseudo-class. */
export const themeTokens = { color: 'var(--text)', background: 'var(--surface)' }

/** Headline balancing is CSS now: no measurement pass in JavaScript. */
export const titleStyle = { textWrap: 'balance' }

/** A required dropdown only reports a bad state after the user has interacted with it. */
export const selectState = 'user-invalid'
