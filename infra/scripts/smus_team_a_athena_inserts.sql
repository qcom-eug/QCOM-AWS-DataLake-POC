-- Run in the SMUS Athena SQL editor as a Team A user.
-- Before each test run, replace every REPLACE_RUN_ID with the same unique,
-- SQL-safe identifier (letters, digits, hyphens or underscores).
-- Run statements individually. Do not rerun an INSERT with the same identifier.
-- Each SELECT should return matched_rows = 1. Test rows are left in the tables.

-- Scenario 1: LF-Tag grants
INSERT INTO qcom_datalake_poc_dev_scenario1_lf_tag.customers
  (customer_id, name, email)
VALUES ('smus-write-REPLACE_RUN_ID-s1-customer', 'SMUS Write Test', 'smus-write@example.com');

SELECT COUNT(*) AS matched_rows
FROM qcom_datalake_poc_dev_scenario1_lf_tag.customers
WHERE customer_id = 'smus-write-REPLACE_RUN_ID-s1-customer';

INSERT INTO qcom_datalake_poc_dev_scenario1_lf_tag.products
  (product_id, name, price)
VALUES ('smus-write-REPLACE_RUN_ID-s1-product', 'SMUS Write Test', 1.25);

SELECT COUNT(*) AS matched_rows
FROM qcom_datalake_poc_dev_scenario1_lf_tag.products
WHERE product_id = 'smus-write-REPLACE_RUN_ID-s1-product';

-- Scenario 2: named Lake Formation grants
INSERT INTO qcom_datalake_poc_dev_scenario2_lf_named.customers
  (customer_id, name, email)
VALUES ('smus-write-REPLACE_RUN_ID-s2-customer', 'SMUS Write Test', 'smus-write@example.com');

SELECT COUNT(*) AS matched_rows
FROM qcom_datalake_poc_dev_scenario2_lf_named.customers
WHERE customer_id = 'smus-write-REPLACE_RUN_ID-s2-customer';

INSERT INTO qcom_datalake_poc_dev_scenario2_lf_named.products
  (product_id, name, price)
VALUES ('smus-write-REPLACE_RUN_ID-s2-product', 'SMUS Write Test', 1.25);

SELECT COUNT(*) AS matched_rows
FROM qcom_datalake_poc_dev_scenario2_lf_named.products
WHERE product_id = 'smus-write-REPLACE_RUN_ID-s2-product';

-- Scenario 3: opted-in Lake Formation path
INSERT INTO qcom_datalake_poc_dev_scenario3_hybrid.customers
  (customer_id, name, email)
VALUES ('smus-write-REPLACE_RUN_ID-s3-customer', 'SMUS Write Test', 'smus-write@example.com');

SELECT COUNT(*) AS matched_rows
FROM qcom_datalake_poc_dev_scenario3_hybrid.customers
WHERE customer_id = 'smus-write-REPLACE_RUN_ID-s3-customer';

INSERT INTO qcom_datalake_poc_dev_scenario3_hybrid.products
  (product_id, name, price)
VALUES ('smus-write-REPLACE_RUN_ID-s3-product', 'SMUS Write Test', 1.25);

SELECT COUNT(*) AS matched_rows
FROM qcom_datalake_poc_dev_scenario3_hybrid.products
WHERE product_id = 'smus-write-REPLACE_RUN_ID-s3-product';
