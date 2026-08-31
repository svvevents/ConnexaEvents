CREATE DEFINER=`root`@`localhost` PROCEDURE `Run_Suppliers_FullMatch`()
BEGIN
	set @attLoop=(select min(id) from supplier_attendees);
	set @maxAttLoop=(select max(id) from supplier_attendees);
    
     WHILE @attLoop < @maxAttLoop -- loop through suppliers
	DO
		SET @attendeeID= (select attendee_id from supplier_attendees where id = @attloop);

		drop temporary table if exists candidatebuyers;
		drop temporary table if exists pref;
    
    /*TABLE WITH ALL BUYER'S IN THE SPECIFIC SUPPLIER'S PREFERENCES WITH FREE APPOINTMENTS GROUPED BY BUYER AND RANKED BY NUMBER OF FREE APPINTMENTS DESC, SO THE MORE FREE APPOINTMENTS THE HIGHER PRIORITY TO MATCH IT GETS*/
			
            create temporary table if not exists CandidateBuyers as 
			SELECT row_number() OVER (ORDER BY COUNT(BM.STATUS) DESC,BM.BUYER_ID ASC )  AS 'ID',BUYER_ID, COUNT(STATUS) as 'Count_FREE_App'
			FROM buyer_meetings BM
				JOIN PREFERENCES P ON BM.BUYER_ID = P.PREFERENCE_ATTID
			WHERE BM.APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT')
			AND BM.STATUS = 'FREE' 
			AND P.ATTENDEE_ID = @attendeeID
			GROUP BY BUYER_ID
			HAVING COUNT(BM.STATUS)>0; -- ENSURE THE BUYERS HAVE FREE APPOINTMENTS
    
    
    /*	TEMP TABLE WITH ALL BUYERS IN THE PREFERENCE LIST OF THE SPECIFIC SUPPLIER (@ATTENDEEID) 
	WITH ALL FREE APPOINTMENTS FOR THIS SUPPLIER 
    WITH BUYERS NOT MEETING ALREADY WITH THIS SUPPLIER
    WITH A PREFERENCE TYPE OF "FULL MATCH" 
    INCLUDING FREE ONLY APPOINTMENTS FOR THE BUYERS (SO THIS SHOULD SHOW ONLY APPOINTMENTS WHICH ARE FREE FOR BOTH BUYER AND SUPPLIER, I THINK.... ) 
*/
			create temporary table if not exists pref as 
				SELECT 	P.ATTENDEE_ID AS 'BUYER_ID', 
						P.ATTENDEE_ORG AS 'BUYER_ORG', 
						P.ATTENDEE_FULLNAME AS 'BUYER_FULLNAME' ,
						P.PREFERENCE_ATTID AS 'SUPPLIER_ID',
						P.PREFERENCE_ORG AS 'SUPPLIER_ORG',
						SM.APPOINTMENT AS 'FREE_APPOINTMENT'
				FROM PREFERENCES P
					JOIN BUYER_ATTENDEES BA ON P.ATTENDEE_ID = BA.ATTENDEE_ID
					JOIN SUPPLIER_MEETINGS SM ON P.PREFERENCE_ATTID  = SM.SUPPLIER_ID
				WHERE P.PREFERENCE_ATTID = @attendeeID
					AND SM.STATUS = 'FREE'	-- ONLY BUYERS WITH FREE SLOTS 
					AND SM.APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT')
					AND P.PREFERENCETYPE = 'FULL MATCH'	-- ONLY BUYERS WITH FULL MATCHES WITH THIS SUPPLIER
					AND BA.ATTENDEE_ID NOT IN (
								SELECT BUYER_ID 
								FROM SUPPLIER_MEETINGS 
								WHERE SUPPLIER_ID = @attendeeID 
								AND BUYER_ID IS NOT NULL
								) -- BUYER DOES NOT ALREADY HAVE A MEETING WITH THIS SUPPLIER
					AND SM.APPOINTMENT IN (	
								SELECT APPOINTMENT 
								FROM BUYER_MEETINGS BM
								WHERE BUYER_ID IN (SELECT PREFERENCE_ATTID FROM PREFERENCES P WHERE ATTENDEE_ID = @attendeeID)
									AND APPOINTMENT NOT IN ('BREAK-1','LUNCH','BREAK-2','CLOSE OF EVENT') 
									AND STATUS = 'FREE'
								)  -- ONLY APPOINTMENTS WHICH ARE FREE FOR THE BUYERS IN THE PREFERENCE SELECTION FOR THE SUPPLIER @attendeeID
				ORDER BY P.ATTENDEE_ID;
		
        IF (SELECT COUNT(BUYER_ID) fROM PREF) = 0
        THEN 
			UPDATE ATTENDEES SET FULLMATCH = 0 WHERE ID = @attendeeID;
            SET @attLoop=@attLoop+1;
		ELSE
        
            /* this will get the buyer_ID, supplier_id and AppointmentNumber*/
            select cb.id, pref.supplier_id , pref.free_appointment, 'FULL_MATCH'  
            into @buyerID, @supplierID,@AppointmentNum,@AppointmentType
            from pref 
            join candidatebuyers cb on pref.buyer_id = cb.buyer_id 
            order by cb.id asc, pref.free_appointment asc limit 1 ;
            
            /*UPDATE DIARIES*/
			CALL UPDATEDIARIES(@buyerID, @supplierID,@AppointmentNum,@AppointmentType);    
			SET @attLoop=@attLoop+1;
		END IF;
	END WHILE;
END