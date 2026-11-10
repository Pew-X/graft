/**
 * The visitor's saved theme, applied before the page is painted. Without this, a visitor who chose
 * light on a system that prefers dark would see dark first and a flash to light on every load, and
 * pages without the toggle (the operator's, the not-found page) would ignore the choice. It runs as
 * a small inline script in the document head; reading storage can throw, and then the system's
 * theme simply stands.
 */
export const THEME_KEY = "graft-theme";

export const themeInitScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
