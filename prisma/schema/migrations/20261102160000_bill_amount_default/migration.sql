-- A vendor bill's amount may be left blank: it then takes the PO's received-but-unbilled value.
ALTER TABLE `VendorBill` ALTER COLUMN `amount` SET DEFAULT 0;
