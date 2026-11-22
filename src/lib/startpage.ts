// Where Katana Desk opens (Settings › General › Opens on), as plain rules so `npm test` checks them.
// Never on a source that isn't connected: a PC with only its own books opens on them, not on Grimmory's
// sign-in (Katana on Android once opened on "Kavita isn't connected" for someone who only reads Local books).

export type StartPage = "grimmory" | "local" | "journal";

export function startPage(opensOn: string | null, signedIn: boolean): StartPage {
  if (opensOn === "journal" || opensOn === "local") return opensOn;
  if (opensOn === "grimmory") return signedIn ? "grimmory" : "local";
  // automatic, and the book read last (which opens over the library): Grimmory once signed in
  return signedIn ? "grimmory" : "local";
}
