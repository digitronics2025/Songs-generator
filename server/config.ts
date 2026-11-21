import { initializeApp, getApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import firebase from "../firebase-applet-config.json";

export function firebaseServices() {
  const emulator = process.env.STUDIO_EMULATOR === "1";
  if (emulator && (!process.env.FIRESTORE_EMULATOR_HOST ||
      !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST)) {
    throw new Error("Studio emulator mode requires all three Firebase emulators.");
  }
  const projectId = emulator ? "demo-darija-studio" : firebase.projectId;
  const storageBucket = emulator ? "demo-darija-studio.appspot.com" : firebase.storageBucket;
  const app = getApps().length ? getApp() : initializeApp({ projectId, storageBucket });
  return {
    auth: getAuth(app),
    db: getFirestore(app, emulator ? "(default)" : firebase.firestoreDatabaseId),
    bucket: getStorage(app).bucket(),
  };
}
export type FirebaseServices = ReturnType<typeof firebaseServices>;
