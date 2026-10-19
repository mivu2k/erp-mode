-- A serial-tracked unit can carry several codes (IMEI 2, MAC, old serial…), one per line.
ALTER TABLE `SerialItem` ADD COLUMN `codes` TEXT NULL;
