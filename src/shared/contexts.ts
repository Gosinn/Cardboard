/**
 * The authenticated context of every sealed thing, shared by the devices that
 * seal and open them and the server that files them (so a log entry can say
 * which key opens the name it copied). Changing one breaks old data, so they
 * never change.
 */
export const ctx = {
  accountKey: (via: "device" | "kit" | "friends" | "pairing" | "passkey") => `account-key|${via}`,
  /** A passkey-locked device's envelope: the passkey-sealed account key, sealed again by the device's own key. */
  lockedEnvelope: "locked-envelope",
  /** A locked device's token, sealed by its passkey. Kept on that device only. */
  deviceToken: "device-token",
  boxKey: (boxId: string) => `box-key|${boxId}`,
  boxName: (boxId: string) => `box-name|${boxId}`,
  boxProfile: (boxId: string) => `box-profile|${boxId}`,
  itemName: (boxId: string, idx: string) => `item-name|${boxId}|${idx}`,
  itemValue: (boxId: string, idx: string) => `item-value|${boxId}|${idx}`,
  /** Details an app or device attaches to a log entry: sealed by the box key, or the account's meta key. */
  logNote: (boxId: string | null) => `log-note|${boxId ?? "account"}`,
  tapeBundle: (boxId: string) => `tape-bundle|${boxId}`,
  tapeLabel: (boxId: string) => `tape-label|${boxId}`,
  deviceLabel: "device-label",
  profile: "profile",
  dockKey: (dockId: string) => `dock-key|${dockId}`,
  dockName: (dockId: string) => `dock-name|${dockId}`,
  berthKey: (dockId: string, boxId: string) => `berth-key|${dockId}|${boxId}`,
  dockAsk: (boxId: string, idx: string) => `dock-ask|${boxId}|${idx}`,
  parcel: (dockId: string, parcelId: string) => `parcel|${dockId}|${parcelId}`,
  signIn: (clientId: string) => `sign-in|${clientId}`,
  pairingMac: "pairing-mac",
  /** A share link's envelope (the box key and name), sealed by a key made from the link's secret. */
  share: (boxId: string) => `share|${boxId}`,
  /** The owner's note on who a share is for, sealed by the owner's meta key. */
  shareLabel: (boxId: string) => `share-label|${boxId}`,
  /** A shared box's key and name, sealed by the member's own account keys. */
  memberBoxKey: (boxId: string) => `member-box-key|${boxId}`,
  memberBoxName: (boxId: string) => `member-box-name|${boxId}`,
  /** What a box's people call each other, sealed by the box key. */
  ownerLabel: (boxId: string) => `owner-label|${boxId}`,
  memberLabel: (boxId: string, memberId: string) => `member-label|${boxId}|${memberId}`,
} as const;
