# Redis Implementation in TrackEasy

This document outlines where and how Redis is utilized in the application, specifically within `routes/shop.js`, and the specific use cases for each implementation.

## 1. Caching Product Lists
**Endpoint:** `GET /api/shop/products`

### Use Case: Performance Optimization & Load Reduction
- **Problem**: The "View Products" page is one of the most visited pages. Querying MongoDB every time a user views this page puts unnecessary load on the database, especially since product details don't change often.
- **Solution**: We cache the result of the database query in Redis (an in-memory store).
- **Benefit**: Redis returns data in milliseconds, significantly speeding up the page load time for customers and vendors while reducing CPU and memory usage on the MongoDB server.

### Implementation
```javascript
// Check Redis Cache
const cachedProducts = await redisClient.get(cacheKey);
if (cachedProducts) {
     console.log('Redis Cache Hit:', cacheKey);
     return res.json(JSON.parse(cachedProducts));
}

const products = await Product.find(query).populate('vendor', 'username');

// Set Redis Cache (Expire in 1 hour)
await redisClient.set(cacheKey, JSON.stringify(products), { EX: 3600 });
```

## 2. Invalidating Cache on Changes (Cache Invalidation)

### Use Case: Data Consistency
- **Problem**: If we only cache data, users might see old product details (e.g., an old price or a deleted product) until the cache expires (1 hour).
- **Solution**: We strictly enforce "Cache Invalidation". Whenever the source data changes (Add, Update, Delete), we immediately remove the corresponding keys from Redis.
- **Benefit**: This ensures that the application provides the speed of caching without sacrificing data accuracy. Users see the new changes immediately after they are made.

### Implementation

#### Adding a Product
**Endpoint:** `POST /api/shop/products`
```javascript
// Invalidate Cache
await redisClient.del('products:all');
await redisClient.del(`products:vendor:${req.userId}`);
```

#### Updating a Product
**Endpoint:** `PUT /api/shop/products/:id`
```javascript
// Invalidate Cache
await redisClient.del('products:all');
if (req.userRole === 'vendor') {
     await redisClient.del(`products:vendor:${req.userId}`);
} else {
    // Logic for admin updates to invalidate vendor-specific cache
    if (product.vendor) {
        await redisClient.del(`products:vendor:${product.vendor}`);
    }
}
```

#### Deleting a Product
**Endpoint:** `DELETE /api/shop/products/:id`
```javascript
// Invalidate Cache
await redisClient.del('products:all');
if (req.userRole === 'vendor') {
     await redisClient.del(`products:vendor:${req.userId}`);
}
```
