import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDyQzcXtOxaVq69IiZMDt5QHbXacRD3AVE",
  authDomain: "karaoke-express.firebaseapp.com",
  projectId: "karaoke-express",
  storageBucket: "karaoke-express.firebasestorage.app",
  messagingSenderId: "382690273372",
  appId: "1:382690273372:web:146bb17951c1ae54359e99"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
