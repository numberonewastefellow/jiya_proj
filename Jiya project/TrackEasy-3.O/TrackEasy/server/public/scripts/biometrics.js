/**
 * biometrics.js - Behavioral Biometrics Collector
 * Tracks mouse dynamics and scroll patterns to detect bot behavior.
 */

class BiometricsCollector {
  constructor() {
    this.mouseEvents = [];
    this.scrollEvents = [];
    this.startTime = Date.now();
    this.lastPos = null;
    this.lastTime = null;
    this.isTracking = false;

    // Aggregated Metrics
    this.metrics = {
      avgVelocity: 0,
      maxVelocity: 0,
      avgAcceleration: 0,
      totalDistance: 0,
      scrollJitter: 0,
      idleTime: 0,
      straightLineRatio: 0, // 1.0 = perfect lines (sus), lower = human curve
      eventCount: 0
    };

    this.init();
  }

  init() {
    window.addEventListener('mousemove', (e) => this.recordMouseMove(e));
    window.addEventListener('wheel', (e) => this.recordScroll(e));
    this.isTracking = true;
    console.log("Behavioral Biometrics tracking started...");
  }

  recordMouseMove(e) {
    const now = Date.now();
    const pos = { x: e.clientX, y: e.clientY };

    if (this.lastPos) {
      const dt = now - this.lastTime;
      if (dt > 0) {
        const dx = pos.x - this.lastPos.x;
        const dy = pos.y - this.lastPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const velocity = dist / dt;

        this.metrics.totalDistance += dist;
        this.metrics.maxVelocity = Math.max(this.metrics.maxVelocity, velocity);
        
        // Simplified jitter/straight line detection
        // Humans rarely move in perfect 0, 45, 90 degree increments for long
        this.mouseEvents.push({ velocity, dist, dt, dx, dy });
      }
    } else {
      this.startTime = now;
    }

    this.lastPos = pos;
    this.lastTime = now;
    this.metrics.eventCount++;
  }

  recordScroll(e) {
    this.scrollEvents.push({
      deltaY: Math.abs(e.deltaY),
      time: Date.now()
    });
  }

  getMetrics() {
    const now = Date.now();
    const duration = now - this.startTime;

    // Calculate Averages
    if (this.mouseEvents.length > 0) {
      const sumVel = this.mouseEvents.reduce((a, b) => a + b.velocity, 0);
      this.metrics.avgVelocity = sumVel / this.mouseEvents.length;

      // Calculate "Bot-like" Straight Line Ratio
      // We check if dx or dy is consistently 0 (perfect horizontal/vertical move)
      let straightCount = 0;
      this.mouseEvents.forEach(ev => {
        if (Math.abs(ev.dx) < 1 || Math.abs(ev.dy) < 1) straightCount++;
      });
      this.metrics.straightLineRatio = straightCount / this.mouseEvents.length;
    }

    // Calculate Scroll Jitter (standard deviation of deltas)
    if (this.scrollEvents.length > 1) {
      const deltas = this.scrollEvents.map(e => e.deltaY);
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const squareDiffs = deltas.map(d => Math.pow(d - avg, 2));
      const variance = squareDiffs.reduce((a, b) => a + b, 0) / deltas.length;
      this.metrics.scrollJitter = Math.sqrt(variance);
    }

    this.metrics.idleTime = duration - (this.mouseEvents.length * 10); // Approximation
    
    return {
      ...this.metrics,
      duration,
      timestamp: new Date().toISOString()
    };
  }

  reset() {
    this.mouseEvents = [];
    this.scrollEvents = [];
    this.startTime = Date.now();
    this.metrics = {
      avgVelocity: 0,
      maxVelocity: 0,
      avgAcceleration: 0,
      totalDistance: 0,
      scrollJitter: 0,
      idleTime: 0,
      straightLineRatio: 0,
      eventCount: 0
    };
  }
}

// Global instance
window.biometrics = new BiometricsCollector();
