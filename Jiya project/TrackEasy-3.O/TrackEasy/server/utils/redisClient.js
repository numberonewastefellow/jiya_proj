// MOCK REDIS CLIENT
// This allows the server to run locally without crashing when Redis is not installed.
const mockClient = {
    on: (event, cb) => {},
    connect: async () => console.log('✅ Connected to Mock Redis (Caching Bypassed)'),
    get: async (key) => null, // Always return a cache miss
    set: async (key, value, options) => {},
    del: async (key) => {}
};

module.exports = mockClient;
