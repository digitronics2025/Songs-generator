import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

const emulator = import.meta.env.DEV && import.meta.env.VITE_STUDIO_EMULATOR === "1";
const app = initializeApp(emulator ? {
  projectId: "demo-darija-studio",
  apiKey: "demo-firebase-api-key",
  authDomain: "localhost",
} : firebaseConfig);

export const auth = getAuth(app);
if (emulator) connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
export const googleProvider = new GoogleAuthProvider();
