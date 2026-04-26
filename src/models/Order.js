/**
 * Order Model — Multi-Tenant
 * In production, replace with a DB table that includes business_id as a column.
 */

const orders = new Map();

export const createOrder = ({ businessId, customerNumber, product, amount, status = 'pending' }) => {
  const order = {
    id: `ord_${Date.now()}`,
    businessId,
    customerNumber,
    product,
    amount,
    status,
    createdAt: new Date(),
  };
  orders.set(order.id, order);
  return order;
};

export const updateOrderStatus = (orderId, status) => {
  const order = orders.get(orderId);
  if (order) order.status = status;
  return order || null;
};

export const getOrderById = (id) => orders.get(id) || null;

export const getOrdersByBusiness = (businessId) =>
  Array.from(orders.values()).filter((o) => o.businessId === businessId);
