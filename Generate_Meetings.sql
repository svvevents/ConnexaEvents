-- =====================================================================
-- ASSUMPTION TO VERIFY:
--   PREFERENCETYPE value for buyer-initiated preference is
--   'REQUESTED BY BUYER'   -> SELECT DISTINCT PREFERENCETYPE FROM PREFERENCES;
-- Adjust the CALL statements in Generate_Meetings if it differs.
--
-- NOTE: The FULLMATCH / PARTIALMATCH "no candidates this pass" flag on
-- ATTENDEES has been removed from this version — it wasn't being
-- consumed anywhere downstream, so Run_Suppliers_MatchByType no longer
-- writes to ATTENDEES at all, just to the diaries via UPDATEDIARIES.
-- =====================================================================

DELIMITER $$

-- Drop the three separate procedures — replaced by the parameterized one below.
DROP PROCEDURE IF EXISTS `Run_Suppliers_FullMatch` $$
DROP PROCEDURE IF EXISTS `Run_Suppliers_PartialMatch` $$
DROP PROCEDURE IF EXISTS `Run_Suppliers_BuyerMatch` $$
DROP PROCEDURE IF EXISTS `Run_Suppliers_Match` $$
DROP PROCEDURE IF EXISTS `Run_Suppliers_MatchByType` $$
DROP PROCEDURE IF EXISTS `Generate_Meetings` $$


-- =====================================================================
-- Run_Suppliers_MatchByType
--   One procedure, parameterized by match type, replacing the three
--   near-identical copies. Same supplier-iteration structure and
--   repeat-until-stable outer loop as before.
--
--   p_preferenceType : value to match against PREFERENCES.PreferenceType
--   p_appointmentType: value written into the diary via UPDATEDIARIES
--   p_supplierIsAttendee: 0 = Attendee_ID is the buyer, Preference_AttID
--                          is the supplier (FULL MATCH, REQUESTED BY BUYER)
--                         1 = Attendee_ID is the supplier, Preference_AttID
--                          is the buyer (REQUESTED BY SUPPLIER) — confirmed
--                          via data check on 2026-07-03
-- =====================================================================

CREATE DEFINER=`root`@`localhost` PROCEDURE `Run_Suppliers_MatchByType`(
    IN p_preferenceType     VARCHAR(50),
    IN p_appointmentType    VARCHAR(50),
    IN p_supplierIsAttendee TINYINT(1)
)
proc_body: BEGIN

    DECLARE v_done            INT DEFAULT 0;
    DECLARE v_attendeeID      INT;
    DECLARE v_buyerID         INT;
    DECLARE v_supplierID      INT;
    DECLARE v_apptNum         VARCHAR(50);
    DECLARE v_apptType        VARCHAR(50) DEFAULT NULL;
    DECLARE v_anyMatchInPass  INT DEFAULT 1;
    DECLARE v_safety          INT DEFAULT 0;

    DECLARE supplier_cursor CURSOR FOR
        SELECT DISTINCT attendee_id
        FROM supplier_attendees
        ORDER BY attendee_id;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

    DROP TEMPORARY TABLE IF EXISTS candidatebuyers;
    DROP TEMPORARY TABLE IF EXISTS pref;

    CREATE TEMPORARY TABLE candidatebuyers (
        rn              INT,
        buyer_id        INT,
        count_free_app  INT,
        PRIMARY KEY (rn),
        KEY idx_buyer (buyer_id)
    ) ENGINE=MEMORY;

    CREATE TEMPORARY TABLE pref (
        buyer_id          INT,
        buyer_org         VARCHAR(255),
        buyer_fullname    VARCHAR(255),
        supplier_id       INT,
        supplier_org      VARCHAR(255),
        free_appointment  VARCHAR(50),
        PRIMARY KEY (buyer_id, free_appointment)
    ) ENGINE=MEMORY;

    outer_loop: WHILE v_anyMatchInPass = 1 AND v_safety < 5000 DO

        SET v_anyMatchInPass = 0;
        SET v_done = 0;
        SET v_safety = v_safety + 1;

        OPEN supplier_cursor;

        supplier_loop: LOOP

            FETCH supplier_cursor INTO v_attendeeID;
            IF v_done = 1 THEN
                LEAVE supplier_loop;
            END IF;

            TRUNCATE TABLE candidatebuyers;
            TRUNCATE TABLE pref;

            IF p_supplierIsAttendee = 0 THEN

                -- Attendee_ID = buyer, Preference_AttID = supplier
                INSERT INTO candidatebuyers (rn, buyer_id, count_free_app)
                SELECT ROW_NUMBER() OVER (ORDER BY COUNT(BM.STATUS) DESC, BM.BUYER_ID ASC),
                       BM.BUYER_ID,
                       COUNT(BM.STATUS)
                FROM buyer_meetings BM
                JOIN PREFERENCES P
                  ON BM.BUYER_ID = P.ATTENDEE_ID
                WHERE BM.APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT')
                  AND BM.STATUS = 'FREE'
                  AND P.PREFERENCE_ATTID = v_attendeeID
                  AND P.PREFERENCETYPE = p_preferenceType
                GROUP BY BM.BUYER_ID
                HAVING COUNT(BM.STATUS) > 0;

            ELSE

                -- Attendee_ID = supplier, Preference_AttID = buyer
                INSERT INTO candidatebuyers (rn, buyer_id, count_free_app)
                SELECT ROW_NUMBER() OVER (ORDER BY COUNT(BM.STATUS) DESC, BM.BUYER_ID ASC),
                       BM.BUYER_ID,
                       COUNT(BM.STATUS)
                FROM buyer_meetings BM
                JOIN PREFERENCES P
                  ON BM.BUYER_ID = P.PREFERENCE_ATTID
                WHERE BM.APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT')
                  AND BM.STATUS = 'FREE'
                  AND P.ATTENDEE_ID = v_attendeeID
                  AND P.PREFERENCETYPE = p_preferenceType
                GROUP BY BM.BUYER_ID
                HAVING COUNT(BM.STATUS) > 0;

            END IF;

            IF p_supplierIsAttendee = 0 THEN

                -- Attendee_ID = buyer, Preference_AttID = supplier
                INSERT INTO pref (buyer_id, buyer_org, buyer_fullname, supplier_id, supplier_org, free_appointment)
                SELECT P.ATTENDEE_ID,
                       P.ATTENDEE_ORG,
                       P.ATTENDEE_FULLNAME,
                       P.PREFERENCE_ATTID,
                       P.PREFERENCE_ORG,
                       SM.APPOINTMENT
                FROM PREFERENCES P
                JOIN BUYER_ATTENDEES BA
                  ON P.ATTENDEE_ID = BA.ATTENDEE_ID
                JOIN SUPPLIER_MEETINGS SM
                  ON P.PREFERENCE_ATTID = SM.SUPPLIER_ID
                 AND SM.STATUS = 'FREE'
                 AND SM.APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT')
                JOIN buyer_meetings BM
                  ON BM.BUYER_ID = P.ATTENDEE_ID
                 AND BM.APPOINTMENT = SM.APPOINTMENT
                 AND BM.STATUS = 'FREE'
                LEFT JOIN SUPPLIER_MEETINGS EXISTING_MTG
                  ON EXISTING_MTG.SUPPLIER_ID = v_attendeeID
                 AND EXISTING_MTG.BUYER_ID = P.ATTENDEE_ID
                WHERE P.PREFERENCE_ATTID = v_attendeeID
                  AND P.PREFERENCETYPE = p_preferenceType
                  AND EXISTING_MTG.BUYER_ID IS NULL;

            ELSE

                -- Attendee_ID = supplier, Preference_AttID = buyer
                -- (REQUESTED BY SUPPLIER: buyer's org/name live in the
                -- Preference_* columns, split across first/last name)
                INSERT INTO pref (buyer_id, buyer_org, buyer_fullname, supplier_id, supplier_org, free_appointment)
                SELECT P.PREFERENCE_ATTID,
                       P.PREFERENCE_ORG,
                       CONCAT_WS(' ', P.PREFERENCE_FIRSTNAME, P.PREFERENCE_LASTNAME),
                       P.ATTENDEE_ID,
                       P.ATTENDEE_ORG,
                       SM.APPOINTMENT
                FROM PREFERENCES P
                JOIN BUYER_ATTENDEES BA
                  ON P.PREFERENCE_ATTID = BA.ATTENDEE_ID
                JOIN SUPPLIER_MEETINGS SM
                  ON P.ATTENDEE_ID = SM.SUPPLIER_ID
                 AND SM.STATUS = 'FREE'
                 AND SM.APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT')
                JOIN buyer_meetings BM
                  ON BM.BUYER_ID = P.PREFERENCE_ATTID
                 AND BM.APPOINTMENT = SM.APPOINTMENT
                 AND BM.STATUS = 'FREE'
                LEFT JOIN SUPPLIER_MEETINGS EXISTING_MTG
                  ON EXISTING_MTG.SUPPLIER_ID = v_attendeeID
                 AND EXISTING_MTG.BUYER_ID = P.PREFERENCE_ATTID
                WHERE P.ATTENDEE_ID = v_attendeeID
                  AND P.PREFERENCETYPE = p_preferenceType
                  AND EXISTING_MTG.BUYER_ID IS NULL;

            END IF;

            IF (SELECT COUNT(*) FROM pref) > 0 THEN

                SELECT cb.buyer_id, pr.supplier_id, pr.free_appointment, p_appointmentType
                INTO v_buyerID, v_supplierID, v_apptNum, v_apptType
                FROM pref pr
                JOIN candidatebuyers cb ON pr.buyer_id = cb.buyer_id
                ORDER BY cb.rn ASC, pr.free_appointment ASC
                LIMIT 1;

                CALL UPDATEDIARIES(v_buyerID, v_supplierID, v_apptNum, v_apptType);

                SET v_anyMatchInPass = 1;

            END IF;

        END LOOP supplier_loop;

        CLOSE supplier_cursor;

    END WHILE outer_loop;

    DROP TEMPORARY TABLE IF EXISTS candidatebuyers;
    DROP TEMPORARY TABLE IF EXISTS pref;

END proc_body $$


-- =====================================================================
-- Generate_Meetings (orchestrator)
--   Runs each match type to full exhaustion, in priority order, so
--   higher-priority match types always get first claim on a shared
--   free appointment slot: mutual Full Match, then supplier-led,
--   then buyer-led.
-- =====================================================================

CREATE DEFINER=`root`@`localhost` PROCEDURE `Generate_Meetings`()
BEGIN
    CALL Run_Suppliers_MatchByType('FULL MATCH',            'FULL MATCH',            0);
    CALL Run_Suppliers_MatchByType('REQUESTED BY SUPPLIER',  'REQUESTED BY SUPPLIER', 1);
    CALL Run_Suppliers_MatchByType('REQUESTED BY BUYER',     'REQUESTED BY BUYER',    0);
END $$

DELIMITER ;