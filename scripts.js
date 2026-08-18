import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

window.addProduct = async function () {
  const title = document.getElementById("title").value;
  const price = document.getElementById("price").value;
  const category = document.getElementById("category").value;
  const desc = document.getElementById("desc").value;

  await addDoc(collection(db, "products"), {
    title,
    price,
    category,
    desc,
    userId: auth.currentUser.uid
  });

  alert("Product Added!");
};