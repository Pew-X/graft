/**
 * Whether perform is part of this build. It is, unless the build is made with `NEXT_PUBLIC_GRAFT_PERFORM=off`:
 * then the perform button, the pads, the perform hint and the perform parts of the keys sheet and the about page
 * are all absent, and nothing else changes. It exists so that the one decision "hold perform back" is a build
 * setting and not a revert. (Dot access on purpose: the build replaces the whole expression.)
 */
declare const process: { env: { NEXT_PUBLIC_GRAFT_PERFORM?: string } };

export const PERFORM_ON: boolean = process.env.NEXT_PUBLIC_GRAFT_PERFORM !== "off";
