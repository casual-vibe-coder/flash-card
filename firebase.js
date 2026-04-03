import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyATB8-6s6bCU_CeDLrfTUC8oa-_rr-JVmU",
  authDomain: "flash-card-20f3d.firebaseapp.com",
  projectId: "flash-card-20f3d",
  storageBucket: "flash-card-20f3d.firebasestorage.app",
  messagingSenderId: "498689479002",
  appId: "1:498689479002:web:5d976c24856d6e15736363",
  measurementId: "G-H6SD3TLZ4H"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
