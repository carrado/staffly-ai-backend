const products = [
    {
      id: 'prod_1',
      business_id: 'biz_demo',
      name: 'Black Sneakers',
      description: 'Comfortable black sneakers',
      size: '42',
      price: 30000,
      stock: 5,
      allow_negotiation: true,
      min_price: 25500,
      image_url: 'https://example.com/images/sneakers.jpg',
    },
    // more products...
  ];
  
  export const getProductsByBusiness = (businessId) =>
    products.filter(p => p.business_id === businessId);
  
  export const findProductByName = (businessId, name) =>
    products.find(p => p.business_id === businessId && p.name.toLowerCase().includes(name.toLowerCase()));
  
  export const getAllProducts = () => products;