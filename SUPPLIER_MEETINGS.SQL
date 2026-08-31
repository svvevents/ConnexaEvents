CREATE TABLE `supplier_meetings` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `SUPPLIER_ID` int DEFAULT NULL,
  `SUPPLIER_ORG` text,
  `SUPPLIER_FULLNAME` text,
  `APPOINTMENT` varchar(50) NOT NULL,
  `TABLE_NUMBER` int DEFAULT NULL,
  `START` text,
  `END` text,
  `STATUS` varchar(45) DEFAULT 'FREE',
  `BUYER_ID` int DEFAULT NULL,
  `BUYER_FULLNAME` text,
  `BUYER_ORG` text,
  `MEETING_TYPE` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_sm_supplier_buyer` (`SUPPLIER_ID`,`BUYER_ID`),
  KEY `idx_sm_supplier_status_appt` (`SUPPLIER_ID`,`STATUS`,`APPOINTMENT`)
) ENGINE=InnoDB AUTO_INCREMENT=5985 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
