const orders = [];

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
  orders.push(order);
  return order;
};

export const updateOrderStatus = (orderId, status) => {
  const order = orders.find(o => o.id === orderId);
  if (order) order.status = status;
};

export const getOrderById = (id) => orders.find(o => o.id === id);