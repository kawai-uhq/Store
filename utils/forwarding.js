// utils/forwarding.js
// BlockCypher Address (Payment) Forwarding for Litecoin.
// Each order gets a unique input_address; funds sent there auto-forward to
// LTC_WALLET_ADDRESS (your main wallet). We match payments by ADDRESS, so two
// buyers can send identical amounts with no collision.

const axios = require('axios');

const BASE = 'https://api.blockcypher.com/v1/ltc/main';

// Create a one-time forwarding address that sweeps to `destination`.
// Returns { id, inputAddress, destination }.
async function createForwardingAddress(destination) {
  const token = process.env.BLOCKCYPHER_TOKEN;
  if (!token) throw new Error('BLOCKCYPHER_TOKEN not set');
  if (!destination) throw new Error('destination (LTC_WALLET_ADDRESS) not set');

  const res = await axios.post(
    `${BASE}/payments?token=${token}`,
    {
      destination,
      // Wait for 1 confirmation on the deposit before BlockCypher forwards it,
      // which reduces double-spend risk on the sweep itself.
      confirmations: 1,
    },
    { timeout: 15000 }
  );

  return {
    id: res.data.id,
    inputAddress: res.data.input_address,
    destination: res.data.destination,
  };
}

// Delete a forwarding address when an order completes or expires (recycles it
// so you don't pile up active forwards on your BlockCypher plan).
async function deleteForwardingAddress(id) {
  const token = process.env.BLOCKCYPHER_TOKEN;
  if (!id || !token) return false;
  try {
    await axios.delete(`${BASE}/payments/${id}?token=${token}`, { timeout: 10000 });
    return true;
  } catch (e) {
    console.warn('[Forwarding] delete failed:', e.response?.status || e.message);
    return false;
  }
}

async function listForwardingAddresses() {
  const token = process.env.BLOCKCYPHER_TOKEN;
  const res = await axios.get(`${BASE}/payments?token=${token}`, { timeout: 10000 });
  return res.data;
}

module.exports = { createForwardingAddress, deleteForwardingAddress, listForwardingAddresses };
