/** What the pad bank's phrase buttons need: the same for the roll's chain and for a sketch bank. */
export interface PhraseControls {
  has: boolean;
  length: number;
  invited: boolean;
  recording: boolean;
  playing: boolean;
  loop: boolean;
  /** Whether this phrase can be sent as a link (a sketch bank's phrase never can). */
  canLink: boolean;
  record: () => void;
  play: () => Promise<void> | void;
  stop: () => void;
  setLoop: (on: boolean) => void;
  clear: () => void;
  copyLink: () => void;
  dismiss: () => void;
}
