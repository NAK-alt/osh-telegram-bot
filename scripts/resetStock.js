/**
 * Script to reset all equipment stock and transaction history:
 * - Available Quantity = Total Quantity (stock back to full)
 * - Borrowed Quantity = 0
 * - Active Loans = [] (reset បញ្ជីអ្នកខ្ចីសកម្ម)
 * - Borrow History = [] (reset ប្រវត្តិប្រតិបត្តិការ)
 * - Return History = []
 * - Stock In History = []
 * - Last Borrowed By / At = null
 * - Status = Available / Low Stock based on Total Quantity
 *
 * Usage:
 *   node scripts/resetStock.js
 */

const { db } = require("../firebase/firebaseAdmin");
const equipmentService = require("../telegramBot/equipmentService");

async function runReset() {
  console.log("Starting equipment stock and history reset...");

  const result = await equipmentService.clearTransactionHistory(true);
  console.log(`Reset applied to ${result.count} equipment item(s).`);

  // Verify all equipment records
  const snapshot = await db.collection("equipment").get();
  let totalAvailable = 0;
  let totalStock = 0;
  let totalActiveLoans = 0;
  let totalBorrowHistory = 0;

  console.log("\n--- Verification Summary ---");
  snapshot.forEach((doc) => {
    const data = doc.data();
    const total = Number(data.totalQuantity) || 0;
    const avail = Number(data.availableQuantity) || 0;
    const borrowed = Number(data.borrowedQuantity) || 0;
    const loans = Array.isArray(data.activeLoans) ? data.activeLoans.length : 0;
    const hist = Array.isArray(data.borrowHistory) ? data.borrowHistory.length : 0;

    totalStock += total;
    totalAvailable += avail;
    totalActiveLoans += loans;
    totalBorrowHistory += hist;

    console.log(
      `[OK] ${data.equipmentName || doc.id}: Total=${total}, Available=${avail}, Borrowed=${borrowed}, ActiveLoans=${loans}`
    );
  });

  console.log("----------------------------");
  console.log(`Total Equipment Items: ${snapshot.size}`);
  console.log(`Total Stock: ${totalStock}`);
  console.log(`Total Available Stock: ${totalAvailable} (${totalStock === totalAvailable ? "100% FULL" : "MISMATCH"})`);
  console.log(`Total Active Loans: ${totalActiveLoans}`);
  console.log(`Total Borrow History Records: ${totalBorrowHistory}`);
  console.log("----------------------------");
  console.log("Reset successfully completed!");
  process.exit(0);
}

runReset().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
