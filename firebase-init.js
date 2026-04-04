import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBQ6Gt8ce7LqlWznMLQjwNj59wJ-AJQQFc",
  authDomain: "whodunnit-6e148.firebaseapp.com",
  projectId: "whodunnit-6e148",
  storageBucket: "whodunnit-6e148.firebasestorage.app",
  messagingSenderId: "489264262384",
  appId: "1:489264262384:web:f3b79dee30dc78789ca635"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);