ALTER TABLE customer_api_keys ADD COLUMN allowed_route_id TEXT REFERENCES model_routes(id) ON DELETE SET NULL;
ALTER TABLE customer_api_keys ADD COLUMN key_encrypted TEXT;

UPDATE customer_api_keys
   SET allowed_route_id = managed_route_id
 WHERE allowed_route_id IS NULL AND managed_route_id IS NOT NULL;

CREATE INDEX idx_api_keys_allowed_route ON customer_api_keys(allowed_route_id);
