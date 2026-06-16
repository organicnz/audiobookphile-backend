import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // Ramp up to 50 users
    { duration: '1m', target: 50 },  // Stay at 50 users for 1 minute
    { duration: '10s', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    http_req_failed: ['rate<0.01'],   // Error rate must be less than 1%
  },
};

export default function () {
  const url = __ENV.API_URL || 'http://localhost:54321/functions/v1/api';
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.SUPABASE_ANON_KEY || 'dummy_key'}`
    },
  };

  const res = http.get(`${url}/check-existing?title=TestBook&author=TestAuthor&libraryId=lib_test123`, params);
  
  check(res, {
    'is status 200': (r) => r.status === 200,
  });
  
  sleep(1);
}
