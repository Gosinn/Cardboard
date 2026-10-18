/**
 * The authenticated context of every sealed thing, shared by the devices that
 * seal and open them and the server that files them (so a log entry can say
 * which key opens the name it copied). Changing one breaks old data, so they
 * never change.
 */
export const ctx = {
  accountKey: (via: "device" | "kit" | "friends" | "pairing") => `account-key|${via}`,
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
} as const;
