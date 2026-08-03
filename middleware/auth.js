const { admin } = require("../firebase/firebaseAdmin");

// Verifies the Firebase ID token sent from the React client in the
// Authorization header: "Bearer <idToken>"
// Since this is a single/two-person personal system, we only check that
// the user is a valid authenticated Firebase user (no role checks).
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).json({ error: "Missing authentication token." });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

module.exports = verifyFirebaseToken;
